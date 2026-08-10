import { create } from "zustand";
import type {
  AgentInfo,
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
  saveActive: (agentId: string, model: string) => Promise<void>;
  loadPacks: () => Promise<void>;
  savePromptHook: (stage: string, files: string[]) => Promise<void>;
}

/** 연결이 확인된 서비스만. 추천 연결 선택기와 추천 경로의 게이트가 이 목록을 본다. */
export function availableAgents(s: AiState): DetectedAgent[] {
  return s.infos
    .map((i) => s.detected[i.id])
    .filter((a): a is DetectedAgent => !!a && a.available);
}

/**
 * 지금 선택된 연결이 실제로 쓸 수 있는 상태인가. 쓸 수 있으면 `{agentId, model}`, 아니면
 * `null` — 호출부는 `null` 을 "로컬 유사도로 간다" 로 읽는다.
 */
export function activeRun(s: AiState): { agentId: string; model: string } | null {
  const active = s.settings?.active;
  if (!active?.agentId) return null;
  const agent = s.detected[active.agentId];
  if (!agent?.available) return null;
  // 원격은 실제 모델 id 를 요구한다. 로컬 CLI 는 비어 있으면 자체 설정을 따른다.
  const model = active.model || (agent.source === "remote" ? "" : "default");
  if (!model) return null;
  return { agentId: active.agentId, model };
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

  saveActive: async (agentId, model) => {
    set({ settings: await api.setActiveAi(agentId, model) });
  },
}));
