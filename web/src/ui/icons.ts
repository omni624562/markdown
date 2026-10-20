import {
  Bold,
  Braces,
  Check,
  ChevronDown,
  CircleAlert,
  Code,
  Columns2,
  Command,
  Copy,
  Download,
  Eye,
  FilePlus,
  FileText,
  FolderOpen,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Monitor,
  Moon,
  PanelLeft,
  Pencil,
  Quote,
  Save,
  SquareCode,
  Strikethrough,
  Sun,
  Table,
  Undo2,
  WandSparkles,
  X,
  createElement,
  type IconNode,
} from "lucide";

const ICONS: Record<string, IconNode> = {
  bold: Bold,
  braces: Braces,
  check: Check,
  "chevron-down": ChevronDown,
  "circle-alert": CircleAlert,
  code: Code,
  "columns-2": Columns2,
  command: Command,
  copy: Copy,
  download: Download,
  eye: Eye,
  "file-plus": FilePlus,
  "file-text": FileText,
  "folder-open": FolderOpen,
  "heading-1": Heading1,
  "heading-2": Heading2,
  "heading-3": Heading3,
  italic: Italic,
  link: Link,
  list: List,
  "list-checks": ListChecks,
  "list-ordered": ListOrdered,
  minus: Minus,
  monitor: Monitor,
  moon: Moon,
  "panel-left": PanelLeft,
  pencil: Pencil,
  quote: Quote,
  save: Save,
  "square-code": SquareCode,
  strikethrough: Strikethrough,
  sun: Sun,
  table: Table,
  "undo-2": Undo2,
  "wand-sparkles": WandSparkles,
  x: X,
};

export function icon(name: string): SVGElement {
  const node = ICONS[name];
  if (!node) throw new Error(`未知的圖示：${name}`);
  const svg = createElement(node, { width: 18, height: 18, "aria-hidden": "true", "stroke-width": 1.75 });
  svg.classList.add("icon");
  return svg;
}

/** 把 HTML 中的 `<i data-icon="名稱"></i>` 換成 SVG 圖示。 */
export function hydrateIcons(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>("i[data-icon]")) {
    el.replaceWith(icon(el.dataset.icon!));
  }
}
