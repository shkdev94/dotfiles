import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export class CenteredEditor extends CustomEditor {
  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    return super.renderTopBorder(width, hiddenLineCount).replaceAll("─", "▔");
  }

  protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
    return super.renderBottomBorder(width, hiddenLineCount).replaceAll("─", "▁");
  }
}

export default function editor(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new CenteredEditor(tui, theme, keybindings, { paddingX: 1, embedWorkingStatus: true }),
    );
  });
}
