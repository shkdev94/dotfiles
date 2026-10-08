import type { Component, TUI } from "@earendil-works/pi-tui";
import { NativeTranscript, type Section } from "./native-transcript.ts";

export type NavigationCommand = "toggle" | "previous" | "next" | "activate" | "exit" | "other";
const labels = { answer: "답변", tool: "도구 결과", thinking: "생각 블록" };

/** Routes navigation without taking editor focus or changing its contents. */
export class SectionNavigation {
  private readonly tui: TUI;
  private readonly transcript: NativeTranscript;
  private readonly report: (message: string) => void;
  private readonly originalRender: Component["render"];
  private readonly documentRender: Component["render"];
  private width: number;
  private sections: Section[] = [];
  private selectedId: string | undefined;
  private selectedIndex = 0;
  private navigating = false;
  private disposed = false;
  private failed = false;
  private anchorPending = false;
  private anchorScheduled = false;
  private highlighted: Component | undefined;
  private restoreHighlight: (() => void) | undefined;

  constructor(tui: TUI, report: (message: string) => void) {
    this.tui = tui;
    this.report = report;
    this.transcript = new NativeTranscript(tui);
    this.width = Math.max(1, tui.terminal.columns - 1);
    this.originalRender = this.transcript.document.render;
    this.documentRender = width => {
      const resized = this.width !== width;
      this.width = width;
      if (this.navigating) {
        if (!this.transcript.editorFocused) this.leave(false);
        else this.safely(() => {
          const previousRow = this.current?.row;
          this.refresh();
          this.highlight();
          if (resized || previousRow !== this.current?.row) this.anchorPending = true;
        });
      }
      const lines = this.originalRender.call(this.transcript.document, width);
      // Wait until Pi has updated ScrollView's content/viewport sizes. Scrolling
      // while measuring a frame uses stale bounds and can lose the requested row.
      this.scheduleAnchor();
      return lines;
    };
    this.transcript.document.render = this.documentRender;
  }

  get active(): boolean {
    return this.navigating;
  }

  get hint(): string | undefined {
    const current = this.current;
    if (!this.navigating || !current) return;
    const action = current.toggle ? " · Enter 펼치기/접기" : "";
    return `섹션 ${this.selectedIndex + 1}/${this.sections.length} · ${labels[current.kind]} · ↑↓ 이동${action} · Esc 입력창`;
  }

  private get current(): Section | undefined {
    return this.sections[this.selectedIndex];
  }

  handle(command: NavigationCommand): boolean {
    if (this.disposed || this.failed) return false;
    if (command === "toggle") {
      if (this.navigating) this.leave();
      else if (!this.transcript.fullscreen) {
        this.report("섹션 탐색은 fullscreen 모드에서 사용할 수 있습니다. /settings에서 TUI mode를 변경하세요.");
      } else if (!this.transcript.editorFocused) return false;
      else this.safely(() => {
        this.refresh();
        if (!this.sections.length) {
          this.report("탐색할 답변·도구 결과·생각 블록이 없습니다.");
          return;
        }
        this.navigating = true;
        this.select(this.sections.length - 1);
      });
      return true;
    }
    if (!this.navigating) return false;
    if (!this.transcript.editorFocused) {
      this.leave();
      return false;
    }
    if (command === "other" || command === "exit") {
      this.leave();
      return command === "exit";
    }
    this.safely(() => {
      this.refresh();
      if (!this.navigating) return;
      if (command === "previous" || command === "next") {
        this.select(this.selectedIndex + (command === "previous" ? -1 : 1));
      } else if (command === "activate" && this.current?.toggle) {
        this.current.toggle();
        this.refresh();
        this.anchorPending = true;
        this.tui.requestRender();
      }
    });
    return true;
  }

  leave(render = true): void {
    const wasNavigating = this.navigating;
    this.navigating = false;
    this.anchorPending = false;
    if (wasNavigating) this.transcript.releaseScrollLock();
    this.restoreHighlight?.();
    this.restoreHighlight = undefined;
    this.highlighted = undefined;
    if (render && !this.disposed) this.tui.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.leave();
    this.disposed = true;
    if (this.transcript.document.render === this.documentRender) {
      this.transcript.document.render = this.originalRender;
    }
  }

  private refresh(): void {
    this.sections = this.transcript.sections(this.width);
    const index = this.sections.findIndex(section => section.id === this.selectedId);
    this.selectedIndex = index >= 0 ? index : Math.min(this.selectedIndex, this.sections.length - 1);
    this.selectedId = this.current?.id;
    if (this.navigating && !this.current) this.leave(false);
  }

  private select(index: number): void {
    this.selectedIndex = Math.max(0, Math.min(index, this.sections.length - 1));
    this.selectedId = this.current?.id;
    this.anchorPending = true;
    this.tui.requestRender();
  }

  private highlight(): void {
    const component = this.current?.component;
    if (component === this.highlighted) return;
    this.restoreHighlight?.();
    this.highlighted = component;
    this.restoreHighlight = undefined;
    if (!component) return;
    const original = component.render;
    const render: Component["render"] = width => {
      if (!this.navigating || this.disposed || this.highlighted !== component) {
        return original.call(component, width);
      }
      // Markdown may return its cached array. Never put selection styling into it.
      const lines = [...original.call(component, width)];
      const index = lines.findIndex(line => line.replace(/\x1b\[[0-9;]*m/g, "").trim().length > 0);
      if (index >= 0) lines[index] = `\x1b[7m${lines[index].replaceAll("\x1b[0m", "\x1b[0;7m")}\x1b[27m`;
      return lines;
    };
    component.render = render;
    this.restoreHighlight = () => {
      // Preserve a renderer installed by another extension after ours.
      if (component.render === render) component.render = original;
    };
  }

  private scheduleAnchor(): void {
    if (!this.anchorPending || this.anchorScheduled || !this.navigating) return;
    this.anchorScheduled = true;
    queueMicrotask(() => {
      this.anchorScheduled = false;
      if (this.disposed || !this.navigating || !this.anchorPending) return;
      this.anchorPending = false;
      this.safely(() => {
        if (this.transcript.editorFocused && this.current) {
          this.transcript.scrollTo(this.current.row);
        }
      });
    });
  }

  private safely(operation: () => void): void {
    try {
      operation();
    } catch (error) {
      this.leave();
      this.failed = true;
      this.report(`섹션 탐색을 중지했습니다: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
