/**
 * Pay4It — Københavns Kommune's Klubkort (widget 0134) and Skolemad
 * (widget 0118), both backed by skolemad-klub.kk.dk.
 *
 * POST https://kkapi.pay4it.dk/V2/Wallet/AulaClubInfo
 * POST https://kkapi.pay4it.dk/V2/Wallet/AulaSchoolInfoV2
 *   Body:    { aulaToken, childs: [<child userId>], date }
 *            The widget token travels in the body, not in a header. No
 *            origin/referer is required.
 *            `childs` takes the per-child userId (UNI-login, e.g. "thit0305").
 *            The numeric Aula child id is accepted but silently matches
 *            nothing (HTTP 200, `Wallets: []`).
 *   Returns: { CanLogin, Wallets: [...] }
 *            Club:   wallets carry WalletBalance / CreditBalance / NFCAdded.
 *            School: wallets carry Dates: { "<YYYY-MM-DD>T00:00:00": [productName] }
 *                    for five days starting at `date` – so pass the Monday.
 *
 * The menu (what can be ordered, not just what is ordered) lives on
 * skolemad-klub.kk.dk itself, behind the same SSO the widget's
 * "Bestil / Afbestil" button uses:
 *   GET  /aula/login?return=&aulaToken=…&userProfile=guardian&returnUrl=/FoodPlannerV3/Index?walletID=…
 *        → session cookies (.AspNet.ApplicationCookie). The returnUrl must carry
 *          the walletID; without it the site logs straight back out.
 *   GET  /api/WalletGroup/GetChildCustomerLocations          (header walletid)
 *        → per wallet: Customers[].FoodPlan { CustomerID, ID }
 *   GET  /api/FoodPlanner/V3?start=<monday>&foodPlanID=…&customerID=…  (header walletid)
 *        → Days[{ Day: 0–4, IsClosed, Products[{ Name, RegistrationDeadline,
 *          MasterCaterInfo.MenuGroup }] }]. MenuGroup "DIS" is the dish of the day
 *          (hovedret), "DAT" the vegetarian alternative, "PLUS" extras.
 */

import type { AulaHttpClient } from '@aula-mcp/aula-auth';
import type { WidgetTokenManager } from '../widget-token-manager.ts';
import { isWidgetTokenExpiredResponse } from '../widget-token-manager.ts';
import { type IntegrationContext, isoDate, isoWeekToMonday } from './types.ts';

const PAY4IT_BASE = 'https://kkapi.pay4it.dk/V2/Wallet';
const KLUBKORT_WIDGET_ID = '0134';
const SKOLEMAD_WIDGET_ID = '0118';
const SKOLEMAD_KLUB = 'https://skolemad-klub.kk.dk';
const MAIN_COURSE_GROUP = 'DIS';

interface Pay4ItWallet {
  ID?: number;
  WalletID?: string;
  Name?: string;
  WalletBalance?: number;
  CreditBalance?: number;
  NFCAdded?: boolean;
  Dates?: Record<string, string[]>;
}

interface Pay4ItResponse {
  CanLogin?: boolean;
  Wallets?: Pay4ItWallet[];
}

interface FoodPlanLocation {
  WalletID?: string;
  Customers?: { FoodPlan?: { CustomerID?: number; ID?: number } | null }[];
}

interface FoodPlanWeek {
  Days?: {
    Day?: number;
    IsClosed?: boolean;
    Products?: {
      Name?: string;
      RegistrationDeadline?: string;
      MasterCaterInfo?: { MenuGroup?: string } | null;
    }[];
  }[];
}

interface MenuDay {
  closed: boolean;
  mainCourse?: string;
  deadline?: string;
}

export interface KlubkortWallet {
  childName?: string;
  walletId?: string;
  /** Balance in DKK. */
  balance?: number;
  /** Subsidy (tilskud) balance in DKK. */
  credit?: number;
  /** Whether the physical club card (NFC) is linked to the wallet. */
  cardAdded?: boolean;
}

export interface Klubkort {
  wallets: KlubkortWallet[];
  raw?: unknown;
  warnings?: string[];
}

export interface SkolemadDay {
  /** YYYY-MM-DD. */
  date: string;
  /** Names of the ordered products; empty when nothing is ordered. */
  products: string[];
  /** With `menu: true`: the dish of the day (hovedret) on the menu. */
  mainCourse?: string;
  /** With `menu: true`: order deadline (ISO, with offset). */
  deadline?: string;
  /** With `menu: true`: the kitchen is closed that day. */
  closed?: boolean;
}

export interface SkolemadChild {
  childName?: string;
  walletId?: string;
  days: SkolemadDay[];
}

export interface Skolemad {
  isoWeek: string;
  children: SkolemadChild[];
  raw?: unknown;
  warnings?: string[];
}

export interface Pay4ItOptions {
  http: AulaHttpClient;
  widgets: WidgetTokenManager;
  klubkortWidgetId?: string;
  skolemadWidgetId?: string;
}

export class Pay4ItClient {
  static readonly id = 'pay4it' as const;
  static readonly capabilities = ['klubkort', 'skolemad'] as const;

  private readonly http: AulaHttpClient;
  private readonly widgets: WidgetTokenManager;
  private readonly klubkortWidgetId: string;
  private readonly skolemadWidgetId: string;

  constructor(opts: Pay4ItOptions) {
    this.http = opts.http;
    this.widgets = opts.widgets;
    this.klubkortWidgetId = opts.klubkortWidgetId ?? KLUBKORT_WIDGET_ID;
    this.skolemadWidgetId = opts.skolemadWidgetId ?? SKOLEMAD_WIDGET_ID;
  }

  /** Klubkort balance per child. */
  async getKlubkort(ctx: IntegrationContext): Promise<Klubkort> {
    const childs = childFilter(ctx);
    const result = await this.post(
      this.klubkortWidgetId,
      'AulaClubInfo',
      childs,
      isoDate(new Date()),
    );
    const wallets = (result.Wallets ?? []).map((w) => {
      const out: KlubkortWallet = {};
      if (w.Name) out.childName = w.Name;
      if (w.WalletID) out.walletId = w.WalletID;
      if (w.WalletBalance !== undefined) out.balance = w.WalletBalance;
      if (w.CreditBalance !== undefined) out.credit = w.CreditBalance;
      if (w.NFCAdded !== undefined) out.cardAdded = w.NFCAdded;
      return out;
    });
    const warnings = emptyWarnings(childs, wallets.length);
    return { wallets, raw: result, ...(warnings.length ? { warnings } : {}) };
  }

  /** Skolemad orders per child and day for `ctx.isoWeek` (Monday–Friday).
   *  With `menu`, each day also gets the menu's dish of the day and deadline. */
  async getSkolemad(ctx: IntegrationContext, opts: { menu?: boolean } = {}): Promise<Skolemad> {
    const childs = childFilter(ctx);
    const monday = isoDate(isoWeekToMonday(ctx.isoWeek));
    const result = await this.post(this.skolemadWidgetId, 'AulaSchoolInfoV2', childs, monday);
    const children = (result.Wallets ?? []).map((w) => {
      const out: SkolemadChild = {
        days: Object.entries(w.Dates ?? {})
          .map(([date, products]) => ({ date: date.slice(0, 10), products: products ?? [] }))
          .sort((a, b) => a.date.localeCompare(b.date)),
      };
      if (w.Name) out.childName = w.Name;
      if (w.WalletID) out.walletId = w.WalletID;
      return out;
    });
    const warnings = emptyWarnings(childs, children.length);
    if (opts.menu) {
      for (const child of children) {
        if (!child.walletId) continue;
        try {
          const menu = await this.getMenu(child.walletId, monday);
          for (const day of child.days) {
            const m = menu.get(day.date);
            if (!m) continue;
            if (m.mainCourse) day.mainCourse = m.mainCourse;
            if (m.deadline) day.deadline = m.deadline;
            if (m.closed) day.closed = true;
          }
        } catch (err) {
          warnings.push(`Skolemad menu unavailable: ${(err as Error).message}`);
        }
      }
    }
    return {
      isoWeek: ctx.isoWeek,
      children,
      raw: result,
      ...(warnings.length ? { warnings } : {}),
    };
  }

  /** Menu per date (YYYY-MM-DD) for the week starting `monday`, via the SSO
   *  session on skolemad-klub.kk.dk. */
  private async getMenu(walletId: string, monday: string): Promise<Map<string, MenuDay>> {
    const token = await this.widgets.get(this.skolemadWidgetId);
    const returnUrl = `/FoodPlannerV3/Index?walletID=${encodeURIComponent(walletId)}&date=${monday}`;
    let url = `${SKOLEMAD_KLUB}/aula/login?${new URLSearchParams({
      return: '',
      aulaToken: token,
      userProfile: 'guardian',
      returnUrl,
    })}`;
    for (let hop = 0; ; hop++) {
      const res = await this.http.request(url, { method: 'GET' });
      const location = res.headers.get('location');
      if (!location) {
        if (res.status !== 200) throw new Error(`login failed (status ${res.status})`);
        break;
      }
      url = new URL(location, url).toString();
      if (/\/account\/logout/i.test(url)) throw new Error('login rejected (redirected to logout)');
      if (hop >= 5) throw new Error('login: too many redirects');
    }

    const headers = {
      walletid: walletId,
      'x-requested-with': 'XMLHttpRequest',
      accept: 'application/json',
    };
    const locations = await this.getJson<FoodPlanLocation[]>(
      `${SKOLEMAD_KLUB}/api/WalletGroup/GetChildCustomerLocations`,
      headers,
    );
    const location = locations.find((l) => l.WalletID === walletId) ?? locations[0];
    const plan = location?.Customers?.find((c) => c.FoodPlan)?.FoodPlan;
    if (plan?.ID === undefined || plan.CustomerID === undefined)
      throw new Error('no food plan for the wallet');
    const week = await this.getJson<FoodPlanWeek>(
      `${SKOLEMAD_KLUB}/api/FoodPlanner/V3?${new URLSearchParams({
        start: monday,
        foodPlanID: String(plan.ID),
        customerID: String(plan.CustomerID),
      })}`,
      headers,
    );

    const start = new Date(`${monday}T00:00:00Z`);
    const menu = new Map<string, MenuDay>();
    for (const d of week.Days ?? []) {
      if (d.Day === undefined) continue;
      const date = isoDate(new Date(start.getTime() + d.Day * 86_400_000));
      const main = (d.Products ?? []).find(
        (p) => p.MasterCaterInfo?.MenuGroup === MAIN_COURSE_GROUP,
      );
      const day: MenuDay = { closed: d.IsClosed === true };
      if (main?.Name) day.mainCourse = main.Name;
      if (main?.RegistrationDeadline) day.deadline = main.RegistrationDeadline;
      menu.set(date, day);
    }
    return menu;
  }

  private async getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
    const res = await this.http.request(url, { method: 'GET', headers });
    if (res.status !== 200)
      throw new Error(`${new URL(url).pathname} failed (status ${res.status})`);
    return JSON.parse(res.body) as T;
  }

  private async post(
    widgetId: string,
    path: string,
    childs: string[],
    date: string,
  ): Promise<Pay4ItResponse> {
    return this.widgets.withRetry(widgetId, async (token) => {
      const res = await this.http.request(`${PAY4IT_BASE}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ aulaToken: token, childs, date: `${date}T00:00:00` }),
      });
      if (isWidgetTokenExpiredResponse(res.body, res.status)) {
        return { _expired: true as const, status: res.status, bodySnippet: res.body.slice(0, 200) };
      }
      if (res.status !== 200) {
        throw new Error(`Pay4It ${path} failed (status ${res.status}): ${res.body.slice(0, 200)}`);
      }
      return JSON.parse(res.body) as Pay4ItResponse;
    });
  }
}

/** Pay4It matches children on their userId (UNI-login). Fall back to the
 *  numeric id only so the request is well-formed; it will match nothing. */
function childFilter(ctx: IntegrationContext): string[] {
  return ctx.childIds.map((id, i) => {
    const userId = ctx.childUserIds?.[i];
    return userId && userId.length > 0 ? userId : String(id);
  });
}

function emptyWarnings(childs: string[], found: number): string[] {
  if (found > 0 || childs.length === 0) return [];
  return [
    'Pay4It returned no wallets for the requested children. It matches on the child userId ' +
      '(UNI-login); either the child has no Klubkort/Skolemad account or the userId was not resolved.',
  ];
}
