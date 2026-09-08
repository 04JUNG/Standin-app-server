// /v1/models 의 본체. converter의 "지금 만들 수 있는 것"과 BFF의 "어떻게 보여줄 것인가"를
// 합쳐 클라이언트 계약(Standin-client docs/08 §8-1)으로 만든다.
import { config } from "../config.js";
import {
  ConverterError,
  converterEnabled,
  fetchConverterCharacters,
  type ConverterCharacter,
} from "../converter/client.js";
import {
  CHARACTER_PRESENTATION,
  presentationFor,
  type CharacterGender,
} from "./catalog.js";

/** 지금 만들 수 있는가. 등록은 됐지만 artifact가 아직 없는 캐릭터는 coming_soon이다. */
export type CharacterAvailability = "available" | "coming_soon";

export interface ModelCharacter {
  characterId: string;
  displayName: string;
  gender: CharacterGender;
  availability: CharacterAvailability;
  /** 지금은 builtin뿐이다. 에셋 스토어·사용자 업로드가 들어올 자리. */
  source: "builtin";
  isDefault: boolean;
  rigProfile: string | null;
  revision: string | null;
  previewUrl: string | null;
  description: string | null;
}

export interface ModelCatalog {
  characters: ModelCharacter[];
  defaultCharacterId: string;
}

/**
 * 이 모듈이 config에서 읽는 것들. 테스트가 config를 통째로 흉내 내지 않고 필요한 세 개만
 * 갈아끼울 수 있게 인자로 뺀다(converter client의 `ConverterDeps`와 같은 형태).
 */
export interface CharacterDeps {
  /** FBX 자체가 켜져 있는가. 꺼져 있으면 converter를 부르지도 않는다. */
  enabled: boolean;
  defaultCharacterId: string;
  listUpstream: () => Promise<ConverterCharacter[]>;
}

function defaultDeps(): CharacterDeps {
  return {
    enabled: converterEnabled(),
    defaultCharacterId: config.converterCharacterId,
    listUpstream: () => fetchConverterCharacters(),
  };
}

/**
 * 목록 캐시. converter는 배포 때만 바뀌는 값을 주는데, 저장 한 번에 두 번씩(카탈로그 조회 +
 * export 검증) 물어보면 Blender 태스크에 불필요한 부하가 간다. 짧게 들고 있는다.
 */
const CACHE_TTL_MS = 60_000;
let cache: { at: number; ids: Set<string> } | null = null;

export function __resetCharacterCache(): void {
  cache = null;
}

async function availableIds(deps: CharacterDeps): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.ids;
  const rows = await deps.listUpstream();
  const ids = new Set(rows.map((row) => row.characterId));
  cache = { at: Date.now(), ids };
  return ids;
}

function toModel(
  characterId: string,
  available: boolean,
  upstream: ConverterCharacter | undefined,
  defaultCharacterId: string,
): ModelCharacter {
  const presentation = presentationFor(characterId, upstream?.displayName ?? "");
  return {
    characterId,
    displayName: presentation.displayName,
    gender: presentation.gender,
    availability: available ? "available" : "coming_soon",
    source: "builtin",
    isDefault: characterId === defaultCharacterId,
    rigProfile: upstream?.rigProfile ?? null,
    revision: upstream?.revision ?? null,
    // 앱이 자기가 커밋한 이미지를 먼저 쓴다. 서버 렌더는 후속 과제다.
    previewUrl: null,
    description: presentation.description,
  };
}

/**
 * 클라이언트에 내려줄 체형 목록.
 *
 * ⚠ **converter가 못 만드는 캐릭터도 목록에 남긴다.** artifact URI가 아직 설정되지 않은
 * 여성 체형을 빼 버리면 앱에는 "모델 선택이라는 기능이 없다"로 보인다. `coming_soon`으로
 * 보내면 앱이 회색 "준비 중" 카드를 그려서, 기능은 있고 준비 중이라는 것이 드러난다.
 *
 * 반대로 converter에만 있고 우리 표에 없는 캐릭터도 내보낸다 — 등록된 줄도 모르는 것보다
 * 코드명으로라도 보이는 편이 낫다.
 */
export async function listCharacters(
  overrides: Partial<CharacterDeps> = {},
): Promise<ModelCatalog> {
  const deps = { ...defaultDeps(), ...overrides };
  const upstream = await deps.listUpstream();
  const byId = new Map(upstream.map((row) => [row.characterId, row]));
  const ids = new Set([...Object.keys(CHARACTER_PRESENTATION), ...byId.keys()]);

  const characters = [...ids]
    .map((id) => toModel(id, byId.has(id), byId.get(id), deps.defaultCharacterId))
    .sort((a, b) => {
      const order =
        presentationFor(a.characterId, "").order - presentationFor(b.characterId, "").order;
      return order !== 0 ? order : a.characterId.localeCompare(b.characterId);
    });

  cache = { at: Date.now(), ids: new Set(byId.keys()) };
  return { characters, defaultCharacterId: deps.defaultCharacterId };
}

/** export가 `characterId`를 존중할 수 있는 상태인가. 이 값이 곧 capabilities.characterSelection이다. */
export async function characterSelectionEnabled(
  overrides: Partial<CharacterDeps> = {},
): Promise<boolean> {
  const deps = { ...defaultDeps(), ...overrides };
  if (!deps.enabled) return false;
  try {
    const ids = await availableIds(deps);
    // 기본 체형 하나뿐이면 "고를 수 있다"고 말하지 않는다. 앱이 선택 UI를 열어도
    // 고를 것이 없고, 헛되이 characterId를 실어 보내게 된다.
    return [...ids].some((id) => id !== deps.defaultCharacterId);
  } catch (error) {
    // converter가 잠깐 안 될 때 기능이 있다고 주장하지 않는다. 앱은 false를 "기본 체형으로
    // 저장한다"로 읽고 그렇게 안내한다 — 안전한 쪽이다.
    if (error instanceof ConverterError) return false;
    throw error;
  }
}

/**
 * 지금 이 서버가 노출하는 기능들. **조회 시점**에 계산한다 — 저장된 결과에 굳어 있으면
 * 기록에서 다시 연 작업이 몇 주 전 배포 상태를 보게 된다(types.ts `capabilities` 주석).
 */
export async function currentCapabilities(
  overrides: Partial<CharacterDeps> = {},
): Promise<{
  refine: boolean;
  fbxExport: boolean;
  characterSelection: boolean;
}> {
  return {
    refine: config.refineFeatureEnabled,
    fbxExport: converterEnabled(),
    characterSelection: await characterSelectionEnabled(overrides),
  };
}

export type CharacterCheck = "ok" | "unknown" | "unavailable";

/**
 * export가 받은 characterId를 쓸 수 있는지 본다.
 *
 * `unknown`(우리가 모르는 값)과 `unavailable`(아는 체형인데 지금 못 만듦)을 나누는 이유는
 * 사용자가 할 일이 다르기 때문이다 — 앞은 다시 고르는 것이고, 뒤는 기다리거나 기본
 * 체형으로 저장하는 것이다.
 *
 * ⚠ converter `/characters`는 만들 수 있는 것만 주므로 "registry에 있지만 못 만듦"을
 *   converter에게 물어볼 수 없다. 그래서 판정 기준을 우리 표(CHARACTER_PRESENTATION)로
 *   둔다. 우리도 모르고 converter도 못 주는 값은 `unknown`이다.
 */
export async function checkCharacter(
  characterId: string,
  overrides: Partial<CharacterDeps> = {},
): Promise<CharacterCheck> {
  const known = characterId in CHARACTER_PRESENTATION;
  const ids = await availableIds({ ...defaultDeps(), ...overrides });
  if (ids.has(characterId)) return "ok";
  return known ? "unavailable" : "unknown";
}
