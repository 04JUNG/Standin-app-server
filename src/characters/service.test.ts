// 모델 목록·검증 계약 테스트.
//
// 여기서 지키는 것 하나: **고를 수 없는 체형을 고를 수 있다고 말하지 않는다.** 반대로
// 만들 수 없다고 목록에서 지워 버리지도 않는다 — 앱에는 기능이 없는 것으로 보인다.
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import type { ConverterCharacter } from "../converter/client.js";
import {
  __resetCharacterCache,
  characterSelectionEnabled,
  checkCharacter,
  listCharacters,
} from "./service.js";

const DEFAULT_ID = "standin-master-v2";

/** converter가 **만들 수 있는 것만** 돌려준다는 사실을 그대로 흉내 낸다. */
function upstream(ids: string[]): ConverterCharacter[] {
  return ids.map((id) => ({
    characterId: id,
    displayName: `Upstream ${id}`,
    rigProfile: "mixamo",
    revision: "v2",
  }));
}

function deps(ids: string[], enabled = true) {
  return {
    enabled,
    defaultCharacterId: DEFAULT_ID,
    listUpstream: async () => upstream(ids),
  };
}

beforeEach(() => {
  __resetCharacterCache();
});

test("converter가 못 만드는 체형도 목록에 남기고 coming_soon으로 표시한다", async () => {
  // 여성 artifact URI가 아직 없는 배포. 목록에서 빼면 앱에는 "모델 선택이라는 기능이
  // 없다"로 보인다 — 준비 중이라는 것이 드러나야 한다.
  const catalog = await listCharacters(deps([DEFAULT_ID]));
  const byId = new Map(catalog.characters.map((row) => [row.characterId, row]));

  assert.equal(byId.get(DEFAULT_ID)?.availability, "available");
  assert.equal(byId.get("standin-female-v2-lbs")?.availability, "coming_soon");
  assert.equal(catalog.defaultCharacterId, DEFAULT_ID);
});

test("표현은 BFF가 소유한다 — converter의 내부 코드명을 그대로 내보내지 않는다", async () => {
  const catalog = await listCharacters(deps([DEFAULT_ID, "standin-female-v2-lbs"]));
  const male = catalog.characters.find((row) => row.characterId === DEFAULT_ID);

  assert.equal(male?.displayName, "기본 남성");
  assert.equal(male?.gender, "male");
  assert.equal(male?.isDefault, true);
  // rigProfile·revision은 converter의 사실이므로 그대로 통과시킨다.
  assert.equal(male?.rigProfile, "mixamo");
});

test("기본 체형이 목록 맨 앞에 온다", async () => {
  const catalog = await listCharacters(deps([DEFAULT_ID, "standin-female-v2-lbs"]));
  assert.equal(catalog.characters[0]?.characterId, DEFAULT_ID);
});

test("우리가 모르는 캐릭터도 감추지 않는다 — 등록된 줄도 모르는 것보다 낫다", async () => {
  const catalog = await listCharacters(deps([DEFAULT_ID, "standin-newcomer-v1"]));
  const newcomer = catalog.characters.find((row) => row.characterId === "standin-newcomer-v1");

  assert.equal(newcomer?.availability, "available");
  assert.equal(newcomer?.gender, "unspecified");
  assert.equal(newcomer?.displayName, "Upstream standin-newcomer-v1");
});

test("기본 체형뿐이면 characterSelection을 켜지 않는다", async () => {
  // 앱이 선택 UI를 열어도 고를 것이 없다. 그 상태를 true로 알리면 헛되이
  // characterId를 실어 보내게 된다.
  assert.equal(await characterSelectionEnabled(deps([DEFAULT_ID])), false);

  __resetCharacterCache();
  assert.equal(
    await characterSelectionEnabled(deps([DEFAULT_ID, "standin-female-v2-lbs"])),
    true,
  );
});

test("converter가 죽어 있으면 기능이 있다고 주장하지 않는다", async () => {
  const { ConverterError } = await import("../converter/client.js");
  const enabled = await characterSelectionEnabled({
    enabled: true,
    defaultCharacterId: DEFAULT_ID,
    listUpstream: async () => {
      throw new ConverterError("CONVERTER_UNAVAILABLE", "down");
    },
  });
  assert.equal(enabled, false);
});

test("FBX가 꺼진 배포에서는 converter를 부르지도 않는다", async () => {
  let called = false;
  const enabled = await characterSelectionEnabled({
    enabled: false,
    defaultCharacterId: DEFAULT_ID,
    listUpstream: async () => {
      called = true;
      return upstream([DEFAULT_ID, "standin-female-v2-lbs"]);
    },
  });

  assert.equal(enabled, false);
  assert.equal(called, false);
});

test("export 검증은 '모르는 값'과 '아는데 못 만듦'을 나눈다", async () => {
  // 사용자가 할 일이 다르다 — 앞은 다시 고르는 것, 뒤는 기다리거나 기본 체형으로 저장.
  const only = deps([DEFAULT_ID]);
  assert.equal(await checkCharacter(DEFAULT_ID, only), "ok");
  assert.equal(await checkCharacter("standin-female-v2-lbs", only), "unavailable");
  assert.equal(await checkCharacter("not-a-character", only), "unknown");
});
