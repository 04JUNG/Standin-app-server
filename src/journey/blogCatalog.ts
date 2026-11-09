/** Public editorial IDs only; synchronize with the landing blog before adding a post. */
export const BLOG_CATALOG: Record<string, { title: string; sections: Record<string, string> }> = {
  '/blog/introducing-standin/': { title: 'Standin 소개: 러프에서 가까운 3D 포즈를 찾는 작업 도구', sections: { why: '왜 Standin인가', workflow: '작업 흐름', example: '작업 예시', fit: '추천 작업', limits: '역할과 한계', next: '다음 단계' } },
  '/blog/standin-clip-studio-guide/': { title: 'Standin으로 찾은 포즈, 클립스튜디오에서 사용하는 방법', sections: { prepare: '준비', input: '러프 입력', select: '후보 선택', save: '파일 저장', 'import-fbx': 'FBX 가져오기', 'import-bvh': 'BVH 가져오기', adjust: '구도 조정', check: '문제 확인' } },
  '/blog/bvh-vs-fbx/': { title: 'BVH와 FBX의 차이: 클립스튜디오에서는 무엇을 선택할까?', sections: { basics: '핵심 차이', comparison: '비교표', 'choose-bvh': 'BVH 선택', 'choose-fbx': 'FBX 선택', 'standin-choice': 'Standin 저장 선택', misconceptions: '자주 하는 오해', next: '다음 단계' } },
};
export const BLOG_SHARED_SECTIONS = { 'article-intro': '제목·목차', 'article-sources': '참고 자료', 'article-related': '관련 글·다운로드', footer: '사이트 하단', page: '미분류' };
