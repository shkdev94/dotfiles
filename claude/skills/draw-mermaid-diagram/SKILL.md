---
name: draw-mermaid-diagram
description: 시스템 구성, 처리 흐름, 상호작용, 상태 전이, 데이터 모델을 채팅 안에서 다이어그램으로 보여 달라고 요청할 때 사용한다. 근거 자료에서 구조를 확인해 알맞은 Mermaid 다이어그램 종류를 고르고, 인라인 위젯으로 ELK 배치·손그림 전환·다크모드를 갖춘 그림을 렌더링한다. 요청이 없으면 FigJam, Artifact, 이미지 파일을 만들지 않는다.
---

# Mermaid 다이어그램 그리기

## 목표와 역할

설명할 구조를 읽기 쉬운 다이어그램으로 채팅 안에 보여 준다.

- 입력은 사용자 설명, 코드·설정 파일, 문서 등 다이어그램의 근거 자료다.
- 근거를 확인하고, 다이어그램 종류를 고르고, Mermaid를 작성해 인라인 위젯으로 렌더링한다.
- 결과물은 위젯 하나와, 위젯 밖 본문의 설명(관점별 내용, 근거, 단순화와 한계)이다.
- 요청이 없으면 FigJam, Artifact, 이미지·HTML 파일을 만들지 않고 저장소를 수정하지 않는다.

## 근거와 범위

- 노드, 연결, 라벨은 확인한 자료에서 가져온다. 모르는 연결을 채워 넣지 않고 본문에 미확인으로 적는다.
- 생략한 상태나 추정한 실행 순서처럼 단순화한 부분은 본문에 밝힌다.
- 한 그림의 노드는 12개 안팎으로 둔다. 넘으면 관점을 나눠 버튼으로 전환하는 여러 뷰로 만든다.

## 다이어그램 종류 선택

| 보여 줄 것 | 종류 | 배치 |
| --- | --- | --- |
| 처리 흐름, 조건 분기, 파이프라인, 에이전트 그래프 | `flowchart` | ELK |
| 구역이 있는 시스템 구성(한글 라벨) | `flowchart` + `subgraph` | ELK |
| 아이콘이 필요한 인프라 구성 | `architecture-beta` | fcose(고정) |
| 시간 순 상호작용(프로토콜, API 호출) | `sequenceDiagram` | 자동 |
| 상태와 전이 | `stateDiagram-v2` | 자동 |
| 테이블과 관계 | `erDiagram` | 자동 |

- `architecture-beta`는 제목에 영문, 숫자, 공백, 밑줄만 쓸 수 있고(한글, `-`, `.` 불가) 손그림을 지원하지 않는다. 한글이 필요하면 `flowchart` + `subgraph`를 쓴다.
- 손그림(`look: 'handDrawn'`)은 표의 종류 중 `flowchart`와 `stateDiagram-v2`에만 적용된다. 다른 종류는 뷰의 `note`로 알린다.

## 위젯 작성 규칙

- 위젯을 처음 그리기 전에 위젯 도구의 디자인 지침(`mcp__visualize__read_me`)을 불러온다.
- `mermaid@11.4.1`과 `@mermaid-js/layout-elk@0.1.7`을 `cdn.jsdelivr.net`에서 버전을 고정해 불러온다. ELK를 불러오지 못하면 기본 배치로 그리고 안내 문구를 띄운다.
- 흐름도는 `layout: 'elk'`, `curve: 'linear'`, `elk.nodePlacementStrategy: 'NETWORK_SIMPLEX'`를 쓴다.
- `theme: 'base'`를 쓰고, 손그림과 깔끔한 스타일을 버튼으로 전환하게 한다. 기본은 손그림이다.
- 색은 의미별로 다음 중 2~3가지만 쓴다(입력·원본 teal, 처리·도구 purple, 결과 coral, 중립 gray, 분기·노트 amber). `classDef`로 칠하고, `subgraph` 구역은 투명 배경에 점선 테두리로 둔다.
- 다크모드는 `document.documentElement.dataset.mode`를 먼저 보고, 없으면 `prefers-color-scheme`로 판단해 밝은·어두운 팔레트를 고른다.
- 라벨은 큰따옴표로 감싸고 줄바꿈은 `<br/>`로 한다. `end` 같은 예약어는 ID로 쓰지 않는다.
- 렌더링마다 고유한 id를 쓰고 `suppressErrorRendering: true`로 Mermaid 자체 오류 그림을 끈다. Mermaid 로드 실패, 없는 뷰, 문법 오류, 렌더링 실패는 모두 위젯 안에 오류 문구로 표시한다. 문법은 `mermaid.parse`로 먼저 검사하고, 문법이 맞는데 ELK 배치로 렌더링이 실패하면 그 렌더링만 기본 배치로 다시 그린다.
- 설명 글은 위젯이 아니라 본문에 쓴다.

## 위젯 기본 골격

`views`에 뷰를 추가하고 뷰 버튼을 같은 키로 둔다. 뷰가 하나면 뷰 버튼을 지운다. `elk: true`는 흐름도 뷰에만 둔다.

````html
<h2 class="sr-only">그림을 한 문장으로 요약</h2>
<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 8px">
<button type="button" data-view="main">뷰 이름</button>
<span style="flex:1"></span>
<button type="button" data-look="handDrawn">손그림</button>
<button type="button" data-look="classic">깔끔하게</button>
</div>
<p id="note" style="margin:0 0 8px;font-size:13px;color:var(--text-secondary)"></p>
<div id="mm" style="min-height:240px"><p style="margin:0;color:var(--text-secondary);font-size:14px">불러오는 중</p></div>
<script type="module">
const el = document.getElementById('mm');
const note = document.getElementById('note');
const fail = (msg, e) => {
  el.innerHTML = '<p style="margin:0;color:var(--text-danger);font-size:13px"></p>';
  el.firstChild.textContent = msg + (e && e.message ? e.message : e);
};
let mermaid = null;
try {
  mermaid = (await import('https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs')).default;
} catch (e) {
  fail('Mermaid를 불러오지 못했습니다: ', e);
}
if (mermaid) {
  let elkReady = false;
  try {
    mermaid.registerLayoutLoaders((await import('https://cdn.jsdelivr.net/npm/@mermaid-js/layout-elk@0.1.7/dist/mermaid-layout-elk.esm.min.mjs')).default);
    elkReady = true;
  } catch (e) {}
  const mode = document.documentElement.dataset.mode;
  const dark = mode ? mode === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const P = dark
    ? { teal: ['#085041', '#5DCAA5', '#E1F5EE'], purple: ['#3C3489', '#AFA9EC', '#EEEDFE'], coral: ['#712B13', '#F0997B', '#FAECE7'], gray: ['#444441', '#B4B2A9', '#F1EFE8'], amber: ['#633806', '#EF9F27', '#FAEEDA'], line: '#9c9a92', text: '#c2c0b6', bg: '#262624', zone: '#888780', zt: '#D3D1C7' }
    : { teal: ['#E1F5EE', '#0F6E56', '#085041'], purple: ['#EEEDFE', '#534AB7', '#3C3489'], coral: ['#FAECE7', '#993C1D', '#712B13'], gray: ['#F1EFE8', '#5F5E5A', '#2C2C2A'], amber: ['#FAEEDA', '#854F0B', '#633806'], line: '#73726c', text: '#3d3d3a', bg: '#ffffff', zone: '#888780', zt: '#444441' };
  const cd = (name, k) => `classDef ${name} fill:${P[k][0]},stroke:${P[k][1]},color:${P[k][2]}`;
  const zone = (id) => `style ${id} fill:transparent,stroke:${P.zone},stroke-dasharray:5 4,color:${P.zt}`;
  const views = {
    main: { elk: true, note: '', src: `flowchart TB
  subgraph grp["구역 이름"]
    direction LR
    a["입력<br/>설명"]
    b["처리<br/>설명"]
  end
  c["결과"]
  a --> b
  b -->|"라벨"| c
  ${cd('src', 'teal')}
  ${cd('tool', 'purple')}
  ${cd('out', 'coral')}
  class a src
  class b tool
  class c out
  ${zone('grp')}` }
  };
  let view = Object.keys(views)[0];
  let look = 'handDrawn';
  let n = 0;
  function mark() {
    [['view', view], ['look', look]].forEach(([k, v]) => document.querySelectorAll(`[data-${k}]`).forEach(b => {
      const on = b.dataset[k] === v;
      b.setAttribute('aria-pressed', on);
      b.style.borderColor = on ? 'var(--border-accent)' : '';
      b.style.color = on ? 'var(--text-accent)' : '';
    }));
  }
  async function draw(noElk = false) {
    mark();
    const v = views[view];
    if (!v) { fail('정의되지 않은 뷰입니다: ', view); return; }
    const useElk = v.elk && elkReady && !noElk;
    note.textContent = [v.note, v.elk && !elkReady ? 'ELK를 불러오지 못해 기본 배치로 그립니다.' : '', v.elk && elkReady && noElk ? 'ELK 배치로 그리지 못해 기본 배치로 그립니다.' : ''].filter(Boolean).join(' ');
    mermaid.initialize({
      startOnLoad: false,
      suppressErrorRendering: true,
      theme: 'base',
      look,
      layout: useElk ? 'elk' : 'dagre',
      handDrawnSeed: 7,
      fontFamily: '"anthropic-sans", sans-serif',
      elk: { mergeEdges: false, nodePlacementStrategy: 'NETWORK_SIMPLEX' },
      flowchart: { curve: useElk ? 'linear' : 'basis', nodeSpacing: 40, rankSpacing: 56, padding: 12, useMaxWidth: true },
      sequence: { useMaxWidth: true, mirrorActors: false, noteMargin: 8 },
      state: { useMaxWidth: true },
      er: { useMaxWidth: true },
      architecture: { useMaxWidth: true },
      themeVariables: {
        darkMode: dark,
        fontSize: '14px',
        fontFamily: '"anthropic-sans", sans-serif',
        background: P.bg,
        lineColor: P.line,
        textColor: P.text,
        edgeLabelBackground: P.bg,
        primaryColor: P.teal[0], primaryBorderColor: P.teal[1], primaryTextColor: P.teal[2],
        secondaryColor: P.gray[0], tertiaryColor: P.bg,
        actorBkg: P.teal[0], actorBorder: P.teal[1], actorTextColor: P.teal[2], actorLineColor: P.line,
        signalColor: P.text, signalTextColor: P.text,
        noteBkgColor: P.amber[0], noteBorderColor: P.amber[1], noteTextColor: P.amber[2],
        archEdgeColor: P.line, archEdgeArrowColor: P.line, archGroupBorderColor: P.zone,
        attributeBackgroundColorOdd: P.bg, attributeBackgroundColorEven: P.gray[0]
      }
    });
    try {
      await mermaid.parse(v.src);
    } catch (e) {
      fail('Mermaid 문법 오류: ', e);
      return;
    }
    try {
      const { svg } = await mermaid.render('mmd' + (n++), v.src);
      el.innerHTML = svg;
      const s = el.querySelector(':scope > svg');
      if (s) { s.style.display = 'block'; s.style.margin = '0 auto'; s.style.height = 'auto'; }
    } catch (e) {
      if (useElk) return draw(true);
      fail('그리지 못했습니다: ', e);
    }
  }
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => { view = b.dataset.view; draw(); }));
  document.querySelectorAll('[data-look]').forEach(b => b.addEventListener('click', () => { look = b.dataset.look; draw(); }));
  await document.fonts.ready;
  draw();
}
</script>
````

## 확인과 수정

- 위젯 화면은 직접 볼 수 없다. 렌더링 성공을 단정하지 않고, 기대 화면과 실패 시 보이는 문구를 알려 사용자 확인을 받는다.
- 스크린샷을 받으면 박스를 가로지르는 화살표, 글자 대비, 잘림을 확인하고 노드 순서, 구역 방향, 간격을 조정한다.
- 같은 그림을 두 번 고쳐도 만족하지 않으면, 더 고치기 전에 무엇이 문제인지 묻는다.
- 위젯 도구가 없는 환경(터미널 CLI 등)에서는 ` ```mermaid ` 코드 블록으로 전달하고 그 사실을 알린다.
