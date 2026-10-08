import type { Component, ScrollView, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";

export type Section = {
  id: string;
  kind: "answer" | "tool" | "thinking";
  component: Component;
  row: number;
  height: number;
  toggle?: () => void;
};

type Container = Component & { children: Component[] };
type Viewport = TUI & {
  viewportTop: number;
  getPrimaryScrollView(): ScrollView;
  getFocusedComponent(): Component | null;
};

function isContainer(component: Component | undefined): component is Container {
  return component !== undefined && "children" in component && Array.isArray(component.children);
}

function contains(root: Component, target: Component): boolean {
  return root === target || (isContainer(root) && root.children.some(child => contains(child, target)));
}

function isViewport(tui: TUI): tui is Viewport {
  return tui.mode === "fullscreen" && "viewportTop" in tui && typeof tui.viewportTop === "number"
    && "getPrimaryScrollView" in tui && typeof tui.getPrimaryScrollView === "function"
    && "getFocusedComponent" in tui && typeof tui.getFocusedComponent === "function";
}

/**
 * Compatibility boundary for Pi 0.86/0.87's native document -> header/resources/chat
 * tree. These component positions and class names are not an extension API contract.
 * Keep inspection here; never replace messages, execute tools, or rewrite the tree.
 */
export class NativeTranscript {
  readonly document: Container;
  private readonly identities = new WeakMap<Component, number>();
  private nextIdentity = 0;
  private readonly tui: TUI;

  constructor(tui: TUI) {
    this.tui = tui;
    const document = tui.children[0];
    if (!isContainer(document) || document.children.length !== 3 || !isContainer(document.children[2])) {
      throw new Error("Pi 결과 영역 구조를 인식하지 못했습니다");
    }
    this.document = document;
  }

  get fullscreen(): boolean {
    return isViewport(this.tui);
  }

  get editorFocused(): boolean {
    if (!isViewport(this.tui)) return false;
    const focus = this.tui.getFocusedComponent();
    const editorRoot = this.tui.children[4];
    return focus !== null && editorRoot !== undefined && contains(editorRoot, focus)
      && "getText" in focus && typeof focus.getText === "function"
      && "setText" in focus && typeof focus.setText === "function";
  }

  scrollTo(row: number): void {
    if (isViewport(this.tui)) {
      this.tui.getPrimaryScrollView().scrollTo(row, { disableFollow: true });
    }
  }

  releaseScrollLock(): void {
    if (isViewport(this.tui)) {
      const viewport = this.tui.getPrimaryScrollView();
      viewport.scrollTo(viewport.scrollTop);
    }
  }

  private identity(component: Component): number {
    let identity = this.identities.get(component);
    if (identity === undefined) {
      identity = this.nextIdentity++;
      this.identities.set(component, identity);
    }
    return identity;
  }

  sections(width: number): Section[] {
    const [header, resources, chat] = this.document.children;
    if (!header || !resources || !isContainer(chat)) {
      throw new Error("Pi 결과 영역 구조가 변경됐습니다");
    }
    let row = header.render(width).length + resources.render(width).length;
    const sections: Section[] = [];
    for (const owner of chat.children) {
      const height = owner.render(width).length;
      const name = owner.constructor.name;
      if (name === "ToolExecutionComponent" || name === "BashExecutionComponent") {
        if (height > 0) {
          sections.push({ id: `tool:${this.identity(owner)}`, kind: "tool", component: owner, row, height,
            toggle: this.toolToggle(owner) });
        }
      } else if (name === "AssistantMessageComponent") {
        const content = isContainer(owner) ? owner.children[0] : undefined;
        if (!isContainer(content)) throw new Error("Pi 답변 블록 구조를 인식하지 못했습니다");
        let blockRow = row;
        const counts = { answer: 0, thinking: 0 };
        for (const block of content.children) {
          const blockHeight = block.render(width).length;
          const kind = block.constructor.name === "Markdown" ? "answer"
            : block.constructor.name === "MouseRegion" ? "thinking" : undefined;
          if (kind && blockHeight > 0) {
            sections.push({ id: `assistant:${this.identity(owner)}:${kind}:${counts[kind]++}`,
              kind, component: block, row: blockRow, height: blockHeight,
              toggle: kind === "thinking" ? this.thinkingToggle(block, width, blockHeight) : undefined });
          }
          blockRow += blockHeight;
        }
        if (blockRow - row !== height) throw new Error("Pi 답변 레이아웃이 변경됐습니다");
      }
      row += height;
    }
    return sections;
  }

  private toolToggle(component: Component): (() => void) | undefined {
    // Calling the specific expansion method avoids activating a custom renderer's
    // button or link, and cannot run the tool again.
    if (!("expanded" in component) || typeof component.expanded !== "boolean"
      || !("setExpanded" in component) || typeof component.setExpanded !== "function") return;
    if (component.constructor.name === "ToolExecutionComponent"
      && (!("result" in component) || !component.result)) return;
    const setExpanded = component.setExpanded;
    return () => {
      const expanded: unknown = Reflect.get(component, "expanded");
      if (typeof expanded === "boolean") Reflect.apply(setExpanded, component, [!expanded]);
    };
  }

  private thinkingToggle(component: Component, width: number, height: number): (() => void) | undefined {
    if (!component.handleMouse) return;
    const event: TuiMouseEvent = { type: "click", button: "left", x: 0, y: 0,
      screenX: 0, screenY: 0, width, height, shift: false, alt: false, ctrl: false };
    return () => { component.handleMouse?.(event); };
  }
}
