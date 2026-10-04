import { create } from "zustand";
import * as api from "../lib/api";
import * as iwms from "../lib/iwms/api";
import type { IwmsDay, IwmsSettings, IwmsStatus } from "../lib/iwms/types";
import { useStore } from "./useStore";

/**
 * i-WMS 연결 · 설정 상태.
 *
 * 업무 상태(`useStore`)와 수명이 달라 스토어를 나눈다(`aiStore` 와 같은 까닭). `settings` 는
 * `~/.contextflow/iwms.json` 의 사본이고 **백엔드가 원본을 소유한다** — 저장은 통째로 보내고
 * 돌아온 정리된 값으로 갈아치운다.
 */
interface IwmsState {
  settings: IwmsSettings | null;
  status: IwmsStatus | null;
  /** 연결 창이 떠 있는 동안. 같은 버튼을 두 번 누르지 않게 한다. */
  connecting: boolean;
  error: string;

  /** 설정 사본과 연결 상태를 읽는다. 설정 화면 · 검토 화면이 열릴 때 부른다. */
  load: () => Promise<void>;
  saveSettings: (next: IwmsSettings) => Promise<void>;
  connect: () => Promise<IwmsStatus>;
  disconnect: () => Promise<void>;
  /**
   * 그날의 i-WMS 현황. 세션이 없거나 만료면 **한 번** 다시 연결하고 다시 묻는다 — 사내 SSO 라
   * 창이 잠깐 떴다 닫히는 것으로 끝나는 일이 대부분이다.
   */
  day: (date: string) => Promise<IwmsDay>;

  /**
   * 검토 화면(`IwmsPushModal`). 오늘의 한일 팝업을 **대신해** 뜬다 — 이 앱은 모달을 겹치지 않는다.
   * 돌아가기는 그 날짜의 오늘의 한일을 다시 연다.
   */
  push: { day: string } | null;
  /** 정제 · 저장 · 되돌리기가 도는 중. Esc 로 닫지 않는다(실패 사유를 적을 자리가 사라진다). */
  pushBusy: boolean;
  openPush: (day: string) => void;
  closePush: (back: boolean) => void;
}

export const useIwms = create<IwmsState>((set, get) => ({
  settings: null,
  status: null,
  connecting: false,
  error: "",

  load: async () => {
    try {
      const [settings, status] = await Promise.all([iwms.getIwmsSettings(), iwms.iwmsStatus()]);
      set({ settings, status, error: "" });
    } catch (e) {
      set({ error: api.errMessage(e) });
    }
  },

  saveSettings: async (next) => {
    set({ settings: await iwms.saveIwmsSettings(next) });
  },

  connect: async () => {
    if (get().connecting) return get().status ?? (await iwms.iwmsStatus());
    set({ connecting: true });
    try {
      const status = await iwms.iwmsConnect();
      set({ status, error: "" });
      return status;
    } catch (e) {
      const status: IwmsStatus = { connected: false, user: null, base: "", message: api.errMessage(e) };
      set({ status });
      return status;
    } finally {
      set({ connecting: false });
    }
  },

  disconnect: async () => {
    await iwms.iwmsDisconnect();
    set({ status: await iwms.iwmsStatus() });
  },

  day: async (date) => {
    try {
      return await iwms.iwmsDay(date);
    } catch (e) {
      if (api.errKind(e) !== "iwms_session") throw e;
      const status = await get().connect();
      if (!status.connected) throw new Error(status.message);
      return await iwms.iwmsDay(date);
    }
  },

  push: null,
  pushBusy: false,

  openPush: (day) => {
    useStore.getState().set({ dayLogOpen: null });
    set({ push: { day }, pushBusy: false });
  },

  closePush: (back) => {
    const day = get().push?.day;
    set({ push: null, pushBusy: false });
    if (back && day) void useStore.getState().openDayLog(day);
  },
}));
