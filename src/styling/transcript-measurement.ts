import { AssistantMessageComponent, SkillInvocationMessageComponent, ToolExecutionComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { type Component, Container, MouseRegion } from "@earendil-works/pi-tui";

type LayoutChild = { component: Component; height: number };
type MeasuredComponent = Component & {
  children?: Component[];
  mouseLayout?: { width: number; children: LayoutChild[] };
  child?: Component;
  selfRenderContainer?: Component;
  selfRenderHeight?: number;
  imageComponents?: Component[];
  toolDefinition?: { renderShell?: string };
};
interface Projection { render: Component["render"]; view: Component }
interface Rows {
  height: number;
  lines?: string[];
  parent?: Rows;
  start: number;
  offsets?: Map<Component, number>;
}
const projections = new WeakMap<Component, Projection>();

/** Grouping owns this registration; a foreign replacement never inherits its offsets. */
export function registerTranscriptProjection(component: Component, projection: Projection): () => void {
  projections.set(component, projection);
  return () => { if (projections.get(component) === projection) projections.delete(component); };
}

/** A preserving adapter may register only after verifying the renderer it wraps.
 * Refreshed mouseLayout alone cannot prove that returned rows retain native order.
 */
export function isTranscriptRendererSupported(component: Component): boolean {
  const projection = projections.get(component);
  return !!projection && component.render === projection.render
    || component.render === Container.prototype.render
    || component instanceof MouseRegion && component.render === MouseRegion.prototype.render
    || component instanceof ToolExecutionComponent && component.render === ToolExecutionComponent.prototype.render
    || component instanceof UserMessageComponent && component.render === UserMessageComponent.prototype.render
    || component instanceof SkillInvocationMessageComponent && component.render === SkillInvocationMessageComponent.prototype.render
    || component instanceof AssistantMessageComponent && component.render === AssistantMessageComponent.prototype.render;
}

/** Register an owned adapter which preserves its wrapped native coordinates. */
export function registerTranscriptRenderer(component: Component, render: Component["render"]): () => void {
  return registerTranscriptProjection(component, { render, view: component });
}

/** Fresh synchronous measurement only. Never retained as a rendered-history cache. */
export class TranscriptMeasurement {
  private readonly measured = new Map<Component, Map<number, Rows>>();
  private readonly values = new Map<object, unknown>();

  memo<T>(key: object, calculate: () => T): T {
    if (!this.values.has(key)) this.values.set(key, calculate());
    return this.values.get(key) as T;
  }

  private view(component: Component): MeasuredComponent {
    const projection = projections.get(component);
    return (projection && component.render === projection.render ? projection.view : component) as MeasuredComponent;
  }

  /** Capture coordinates immediately, before another width can replace native
   * mouseLayout. Child line slices are materialized only when requested.
   */
  private capture(component: Component, width: number, rows: Rows): Rows {
    let widths = this.measured.get(component);
    const existing = widths?.get(width);
    if (existing) return existing;
    if (!widths) { widths = new Map(); this.measured.set(component, widths); }
    widths.set(width, rows);
    const view = this.view(component);
    if (!isTranscriptRendererSupported(component)) return rows;
    let children: LayoutChild[] | undefined;
    let start = 0;
    if (view.constructor.name === "MouseRegion" && view.render === MouseRegion.prototype.render && view.child) {
      children = [{ component: view.child, height: rows.height }];
    } else if (view.constructor.name === "ToolExecutionComponent" && view.toolDefinition?.renderShell === "self"
      && view.selfRenderContainer && view.imageComponents?.length === 0 && (view.selfRenderHeight ?? 0) > 0
      && rows.height === (view.selfRenderHeight ?? 0) + 1) {
      // Pi's self shell prepends one separator, then the unmodified container.
      start = 1;
      children = [{ component: view.selfRenderContainer, height: rows.height - 1 }];
    } else {
      const layout = view.mouseLayout;
      // Known preserving adapters may use the native layout; unknown renderers
      // cannot reuse it even after calling native rendering themselves.
      if (layout?.width === width
        && Array.isArray(layout.children) && Array.isArray(view.children) && layout.children.length === view.children.length
        && layout.children.every((entry, index) => entry.component === view.children![index]
          && Number.isInteger(entry.height) && entry.height >= 0)
        && layout.children.reduce((sum, entry) => sum + entry.height, 0) === rows.height) children = layout.children;
    }
    if (children) {
      rows.offsets = new Map();
      for (const child of children) {
        rows.offsets.set(child.component, start);
        this.capture(child.component, width, { parent: rows, start, height: child.height });
        start += child.height;
      }
    }
    return rows;
  }

  private lines(rows: Rows): string[] {
    if (!rows.lines) rows.lines = rows.parent ? this.lines(rows.parent).slice(rows.start, rows.start + rows.height) : [];
    return rows.lines;
  }

  render(component: Component, width: number): string[] {
    let rows = this.measured.get(component)?.get(width);
    if (!rows) {
      const lines = component.render(width);
      rows = this.capture(component, width, { lines, start: 0, height: lines.length });
    }
    return this.lines(rows);
  }

  /** Displayed direct-child offsets from this render, not child.render() again.
   * Unknown/padded/transformed layouts do not supply guessed child coordinates.
   */
  offsets(component: Component, width: number): Map<Component, number> | undefined {
    this.render(component, width);
    return this.measured.get(component)?.get(width)?.offsets;
  }
}

const active = new WeakMap<object, TranscriptMeasurement>();

/** Nested pin/reminder predicates share transcript rows, but not dock renders: the
 * reminder is deliberately suppressed while measuring its canonical viewport.
 */
export function withTranscriptMeasurement<T>(owner: object, calculate: (measurement: TranscriptMeasurement) => T): T {
  const existing = active.get(owner);
  if (existing) return calculate(existing);
  const measurement = new TranscriptMeasurement();
  active.set(owner, measurement);
  try { return calculate(measurement); }
  finally { active.delete(owner); }
}
