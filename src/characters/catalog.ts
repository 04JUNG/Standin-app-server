// 클라이언트에 보여줄 체형 정보. converter가 모르는 것들이 여기 있다.
//
// converter registry는 `display_name`을 "Standin Master V2" 같은 내부 코드명으로 갖고 있고
// 성별·설명은 아예 없다. 화면 문구를 Python 저장소에 넣을 이유가 없으므로 표현은 BFF가
// 소유하고, converter는 **지금 만들 수 있는지**만 알려 준다(docs/API.md §모델).

export type CharacterGender = "male" | "female" | "unspecified";

export interface CharacterPresentation {
  displayName: string;
  gender: CharacterGender;
  description: string | null;
  /** 화면 정렬 순서. 작을수록 앞. 모르는 캐릭터는 뒤로 간다. */
  order: number;
}

/**
 * 우리가 아는 체형들.
 *
 * ⚠ 여기 있다고 고를 수 있는 것이 아니다. 실제 가용 여부는 converter `GET /characters`가
 *   정한다 — 목록에 없으면 `coming_soon`으로 나간다. 이 표는 **이름과 순서**만 담당한다.
 *   그래서 여성 artifact가 배포되기 전에도 카드가 보이고, 배포되는 순간 코드 변경 없이
 *   고를 수 있게 된다.
 */
export const CHARACTER_PRESENTATION: Record<string, CharacterPresentation> = {
  "standin-master-v2": {
    displayName: "기본 남성",
    gender: "male",
    description: "표준 남성 체형입니다.",
    order: 10,
  },
  "standin-female-v2-lbs": {
    displayName: "기본 여성",
    gender: "female",
    description: "표준 여성 체형입니다.",
    order: 20,
  },
};

/**
 * 표에 없는 캐릭터도 감춘다고 좋을 것이 없다. converter에 새 캐릭터가 등록되면 코드명
 * 그대로라도 보여주고, 이름은 다음 배포에서 붙인다 — 감추면 등록된 줄도 모른다.
 */
export function presentationFor(
  characterId: string,
  fallbackDisplayName: string,
): CharacterPresentation {
  return (
    CHARACTER_PRESENTATION[characterId] ?? {
      displayName: fallbackDisplayName || characterId,
      gender: "unspecified",
      description: null,
      order: 100,
    }
  );
}
