import { create } from "zustand";
import type {
  ActiveChoice,
  AgentInfo,
  AiFeature,
  AiProConfig,
  AiSettings,
  DetectedAgent,
  FabrixConfig,
  PromptPack,
} from "../lib/ai";
import * as api from "../lib/api";

/**
 * AI 서비스 연결 상태.
 *
 * Vault · 업무 상태(`useStore`)와 수명이 달라 스토어를 분리한다 — 업무를 오가도 연결은
 * 그대로 남아야 하고, 반대로 연결을 고쳤다고 Vault 를 다시 읽을 이유가 없다.
 *
 * `settings` 는 `ai.json` 의 사본이고 **백엔드가 원본을 소유한다.** 모든 `save*` 는
 * 커맨드가 돌려준 전체 설정으로 갈아치운다 — 프런트가 부분 병합하면 백엔드가 이월한
 * 모델 캐시를 지운다.
 */
interface AiState {
  /** 레지스트리(탐지 전에도 카드를 그릴 수 있게) */
  infos: AgentInfo[];
  detected: Record<string, DetectedAgent>;
  settings: AiSettings | null;
  loading: Record<string, boolean>;
  errors: Record<string, string>;
  /** 최초 1회 로딩이 끝났는지 — 설정 화면이 "연결 없음"을 성급히 띄우지 않도록 */
  ready: boolean;
  /**
   * `~/.contextflow/prompts/` 의 팩 목록.
   *
   * 배선(`settings.prompts`)과 같은 파일을 쓰므로 스토어를 따로 두지 않는다 — 둘이
   * 갈라지면 두 스토어가 같은 ai.json 을 서로 덮어쓴다.
   */
  packs: PromptPack[];
  packError: string | null;

  refreshAll: () => Promise<void>;
  detectOne: (id: string, force?: boolean) => Promise<void>;
  saveAgentBin: (id: string, path: string | null) => Promise<void>;
  saveAiPro: (config: AiProConfig | null) => Promise<void>;
  saveFabrix: (config: FabrixConfig | null) => Promise<void>;
  /**
   * 원격 연결 테스트. 성공하면 백엔드가 모델 캐시를 고쳐 두므로 설정 사본과 탐지 결과를
   * 다시 읽는다 — 예전에는 카드가 결과 문구만 띄워, 모델 칩과 선택기가 [모델 다시 조회] 를
   * 누를 때까지 옛 목록에 머물렀다. 실패는 그대로 던진다(카드가 사유를 보여 준다).
   */
  probeOne: (id: "aipro" | "fabrix") => Promise<string>;
  saveActive: (agentId: string, model: string) => Promise<void>;
  /** 기능별 연결. 빈 `agentId` = 기본 연결을 따른다. */
  saveRoute: (feature: AiFeature, agentId: string, model: string) => Promise<void>;
  loadPacks: () => Promise<void>;
  savePromptHook: (stage: string, files: string[]) => Promise<void>;
}

/** 연결이 확인된 서비스만. 추천 연결 선택기와 추천 경로의 게이트가 이 목록을 본다. */
export function availableAgents(s: AiState): DetectedAgent[] {
  return s.infos
    .map((i) => s.detected[i.id])
    .filter((a): a is DetectedAgent => !!a && a.available);
}

/** 연결 하나를 지금 실제로 돌릴 수 있는 `{agentId, model}` 로 푼다. 못 쓰면 `null`. */
function resolveChoice(s: AiState, choice: ActiveChoice | undefined | null) {
  if (!choice?.agentId) return null;
  const agent = s.detected[choice.agentId];
  if (!agent?.available) return null;
  // 원격은 실제 모델 id 를 요구한다. 로컬 CLI 는 비어 있으면 자체 설정을 따른다.
  const model = choice.model || (agent.source === "remote" ? "" : "default");
  if (!model) return null;
  return { agentId: choice.agentId, model };
}

/**
 * 지금 선택된 연결이 실제로 쓸 수 있는 상태인가. 쓸 수 있으면 `{agentId, model}`, 아니면
 * `null` — 호출부는 `null` 을 "로컬 유사도로 간다" 로 읽는다.
 */
export function activeRun(s: AiState): { agentId: string; model: string } | null {
  return resolveChoice(s, s.settings?.active);
}

/**
 * 기능 하나가 쓸 연결.
 *
 * 기능별 연결을 지정했으면 **그것만** 본다 — 지정한 연결이 지금 사용 불가여도 기본 연결로
 * 몰래 바꾸지 않는다. 값싼 모델을 일부러 반영에 골랐을 수 있고, 조용히 대체하면 사용자가
 * 모르는 사이에 다른 서비스로 업무 내용이 나간다. 지정하지 않았으면 기본 연결을 따른다.
 */
export function routeRun(s: AiState, feature: AiFeature): { agentId: string; model: string } | null {
  const route = s.settings?.routes?.[feature];
  return route?.agentId ? resolveChoice(s, route) : activeRun(s);
}

/** 화면에 적을 사정 — 어느 연결을 쓰는지, 왜 못 쓰는지. */
export interface RouteInfo {
  run: { agentId: string; model: string } | null;
  /** `route` = 기능별 지정 · `default` = 기본 연결을 따름 · `none` = 쓸 연결이 없음 */
  via: "route" | "default" | "none";
  /** 쓰는(또는 쓰려던) 연결 이름. */
  name: string | null;
}

export function routeInfo(s: AiState, feature: AiFeature): RouteInfo {
  const route = s.settings?.routes?.[feature];
  const choice = route?.agentId ? route : s.settings?.active;
  const name = choice?.agentId ? (s.detected[choice.agentId]?.name ?? choice.agentId) : null;
  const via = route?.agentId ? "route" : s.settings?.active?.agentId ? "default" : "none";
  return { run: routeRun(s, feature), via, name };
}

export const useAi = create<AiState>((set, get) => ({
  infos: [],
  detected: {},
  settings: null,
  loading: {},
  errors: {},
  ready: false,
  packs: [],
  packError: null,

  detectOne: async (id, force = false) => {
    set((s) => ({ loading: { ...s.loading, [id]: true } }));
    try {
      const agent = await api.detectAgent(id, force);
      set((s) => ({
        detected: { ...s.detected, [id]: agent },
        errors: { ...s.errors, [id]: "" },
      }));
    } catch (err) {
      set((s) => ({ errors: { ...s.errors, [id]: api.errMessage(err) } }));
    } finally {
      set((s) => ({ loading: { ...s.loading, [id]: false } }));
    }
  },

  refreshAll: async () => {
    try {
      const [infos, settings] = await Promise.all([api.listAgents(), api.getAiSettings()]);
      set({ infos, settings });
      // 팩 목록은 실패해도 연결 탐지를 막지 않는다 — 별도 오류 칸에 담는다.
      void get().loadPacks();
      // 캐시 우선(force 없음) — 앱을 열 때마다 사내 게이트웨이를 때리지 않는다.
      await Promise.all(infos.map((i) => get().detectOne(i.id)));
    } catch (err) {
      set((s) => ({ errors: { ...s.errors, _: api.errMessage(err) } }));
    } finally {
      set({ ready: true });
    }
  },

  loadPacks: async () => {
    try {
      set({ packs: await api.listPromptPacks(), packError: null });
    } catch (err) {
      set({ packError: api.errMessage(err) });
    }
  },

  savePromptHook: async (stage, files) => {
    set({ settings: await api.setPromptHook(stage, files) });
  },

  saveAgentBin: async (id, path) => {
    set({ settings: await api.setAgentBin(id, path) });
    await get().detectOne(id, true);
  },

  saveAiPro: async (config) => {
    set({ settings: await api.setAiProConfig(config) });
    await get().detectOne("aipro", true);
  },

  saveFabrix: async (config) => {
    set({ settings: await api.setFabrixConfig(config) });
    await get().detectOne("fabrix", true);
  },

  probeOne: async (id) => {
    const msg = id === "aipro" ? await api.probeAiPro() : await api.probeFabrix();
    try {
      set({ settings: await api.getAiSettings() });
    } catch {
      /* 사본 갱신 실패는 다음 저장이 바로잡는다 */
    }
    // 캐시 우선 탐지 — 방금 테스트가 채운 캐시를 읽으므로 네트워크를 다시 타지 않는다.
    await get().detectOne(id);
    return msg;
  },

  saveActive: async (agentId, model) => {
    set({ settings: await api.setActiveAi(agentId, model) });
  },

  saveRoute: async (feature, agentId, model) => {
    set({ settings: await api.setAiRoute(feature, agentId, model) });
  },
}));
