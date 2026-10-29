import { AssistantMessageComponent, SkillInvocationMessageComponent, ToolExecutionComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { type Component, Container, MouseRegion, type TUI, TuiAltScreen, VStack } from "@earendil-works/pi-tui";

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
interface Projection {
  render: Component["render"];
  view: Component;
  /** Owned adapter: reconcile now, then return the exact native concatenation.
   * This is a freshness capability, not a cached previous-frame child list. */
  freshChildren?: () => readonly Component[] | undefined;
}
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
export function registerTranscriptRenderer(component: Component, render: Component["render"],
  freshChildren?: Projection["freshChildren"]): () => void {
  return registerTranscriptProjection(component, { render, view: component, freshChildren });
}

/** Fresh displayed children only for exact native concatenation or an owned
 * adapter which explicitly supplies that contract. Foreign replacements and
 * merely coordinate-preserving wrappers never inherit this capability. */
export function freshTranscriptChildren(component: Component): readonly Component[] | undefined {
  const projection = projections.get(component);
  if (projection && component.render === projection.render && projection.freshChildren) {
    try {
      const children = projection.freshChildren();
      return projections.get(component) === projection && component.render === projection.render ? children : undefined;
    } catch { return undefined; }
  }
  return component.render === Container.prototype.render ? (component as MeasuredComponent).children : undefined;
}

/** Fresh synchronous measurement only. Never retained as a rendered-history cache. */
export class TranscriptMeasurement {
  private readonly measured = new Map<Component, Map<number, Rows>>();
  private readonly values = new Map<object, unknown>();
  private readonly renderers = new Map<Component, { render: Component["render"]; projection: Projection | undefined }>();
  private revision = 0;

  /** Keep committed non-layout memos, but reject any pre-invalidation work still
   * on the stack: a suspended native render can resume after reentrant cleanup. */
  invalidateRows(): void { this.revision++; this.measured.clear(); this.renderers.clear(); }

  /** Reentrant native renders must not leave either rows or provenance memos live. */
  invalidate(): void { this.invalidateRows(); this.values.clear(); }

  /** A later predicate cannot inherit coordinates after a renderer changes owner,
   * even when native paint ran between predicates and the height stayed equal. */
  validateRenderers(): void {
    for (const [component, captured] of this.renderers) {
      if (component.render !== captured.render || projections.get(component) !== captured.projection) {
        this.invalidateRows();
        return;
      }
    }
  }

  memo<T>(key: object, calculate: () => T): T {
    if (this.values.has(key)) return this.values.get(key) as T;
    const revision = this.revision;
    const value = calculate();
    if (revision === this.revision) this.values.set(key, value);
    return value;
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
    this.renderers.set(component, { render: component.render, projection: projections.get(component) });
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
      const revision = this.revision;
      const lines = component.render(width);
      // Clearing an interrupted measurement cannot cancel native concatenation.
      // Its returned rows may predate reentry even when the renderer is unchanged.
      if (revision !== this.revision) return lines;
      rows = this.capture(component, width, { lines, start: 0, height: lines.length });
    }
    return this.lines(rows);
  }

  /** Read a captured height without materializing a potentially large child slice. */
  height(component: Component, width: number): number {
    return this.measured.get(component)?.get(width)?.height ?? this.render(component, width).length;
  }

  /** Displayed direct-child offsets from this render, not child.render() again.
   * Unknown/padded/transformed layouts do not supply guessed child coordinates.
   */
  offsets(component: Component, width: number): Map<Component, number> | undefined {
    if (!this.measured.get(component)?.has(width)) this.render(component, width);
    return this.measured.get(component)?.get(width)?.offsets;
  }
}

const active = new WeakMap<object, TranscriptMeasurement>();
// Pi 1.4 exports the classes, but not this layout-node symbol or a frame hook.
// Its installed declarations define this exact synchronous instance protocol.
const layoutNode = Symbol.for("@earendil-works/pi-tui/layout-node");
type LayoutRoot = Component & { [layoutNode](): unknown };
type FrameHost = { mode?: string; layoutRoot?: Component; doRender(): void };
interface Frame {
  root: LayoutRoot;
  node: LayoutRoot[typeof layoutNode];
  measurement: TranscriptMeasurement;
  entered: boolean;
}
const frames = new WeakMap<object, Frame>();
const rootHooks = new WeakMap<Component, LayoutRoot[typeof layoutNode]>();
const frameOwners = new WeakMap<object, { render: FrameHost["doRender"]; release: () => void; references: number }>();
const nativeNode = (VStack.prototype as unknown as LayoutRoot)[layoutNode];
const nativeRender = (TuiAltScreen.prototype as unknown as FrameHost).doRender;

function currentFrame(owner: object): Frame | undefined {
  const frame = frames.get(owner);
  const host = owner as FrameHost;
  return frame?.entered && host.mode === "fullscreen" && host.layoutRoot === frame.root
    && frame.root[layoutNode] === frame.node ? frame : undefined;
}

/** One synchronous native paint transaction, with a NEW predicate snapshot for
 * each layout traversal (search can lay out twice). Native painting is NEVER
 * intercepted or served these rows: it must refresh native mouse geometry.
 * This exported boundary also lets fixtures exercise the actual layout engine.
 */
export function withTranscriptFrame<T>(owner: object, render: () => T): T {
  const host = owner as FrameHost;
  const root = host.layoutRoot as LayoutRoot | undefined;
  if (host.mode !== "fullscreen" || !(root instanceof VStack)) return render();
  const original = root[layoutNode];
  if (typeof original !== "function" || original !== nativeNode && original !== rootHooks.get(root)) return render();
  const descriptor = Object.getOwnPropertyDescriptor(root, layoutNode);
  const previous = frames.get(owner);
  const previousActive = active.get(owner);
  const previousHook = rootHooks.get(root);
  const frame: Frame = { root, node, measurement: new TranscriptMeasurement(), entered: false };
  function node() {
    // The root protocol is called before any visibility predicates, once per
    // renderLayoutFrame. Never infer a frame from a timer, width or leaf ID.
    frame.measurement.invalidate();
    frame.entered = true;
    return original.call(root);
  }
  try { Object.defineProperty(root, layoutNode, { configurable: true, writable: true, value: node }); }
  catch { return render(); }
  previous?.measurement.invalidate();
  previousActive?.invalidate();
  active.delete(owner);
  frames.set(owner, frame);
  rootHooks.set(root, node);
  try { return render(); }
  finally {
    frame.measurement.invalidate();
    active.delete(owner);
    if (previous) { previous.measurement.invalidate(); frames.set(owner, previous); }
    else frames.delete(owner);
    if (previousActive) { previousActive.invalidate(); active.set(owner, previousActive); }
    if (root[layoutNode] === node) {
      if (descriptor) Object.defineProperty(root, layoutNode, descriptor);
      else Reflect.deleteProperty(root, layoutNode);
    }
    if (rootHooks.get(root) === node) {
      if (previousHook) rootHooks.set(root, previousHook);
      else rootHooks.delete(root);
    }
  }
}

/** Ref-counted, guarded Pi 1.4 instance adapter; no prototype/host-file patch.
 * A foreign doRender or layout-node owner retains the unoptimized native path.
 */
export function retainTranscriptFrames(tui: TUI): () => void {
  const host = tui as unknown as FrameHost;
  let owner = frameOwners.get(tui);
  if (owner && host.doRender !== owner.render) return () => {};
  if (!owner) {
    const original = host.doRender;
    if (original !== nativeRender) return () => {};
    const descriptor = Object.getOwnPropertyDescriptor(host, "doRender");
    const render = () => host.doRender === render ? withTranscriptFrame(tui, () => original.call(host)) : original.call(host);
    const release = () => {
      if (host.doRender === render) {
        if (descriptor) Object.defineProperty(host, "doRender", descriptor);
        else Reflect.deleteProperty(host, "doRender");
      }
    };
    try { Object.defineProperty(host, "doRender", { configurable: true, writable: true, value: render }); }
    catch { return () => {}; }
    owner = { render, release, references: 0 };
    frameOwners.set(tui, owner);
  }
  const retained = owner;
  retained.references++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--retained.references) return;
    retained.release();
    if (frameOwners.get(tui) === retained) frameOwners.delete(tui);
  };
}

/** A newly bound/retired prose decorator must not leave old paint in predicates. */
export function invalidateTranscriptRows(owner: object): void {
  active.get(owner)?.invalidateRows();
  currentFrame(owner)?.measurement.invalidateRows();
}

/** Nested predicates share rows, but NOT dock renders or visibility decisions:
 * canonical measurements suppress different rows. `shared` means a nested
 * predicate, not merely a frame: independent follow-end pins keep fresh suffixes.
 */
export function withTranscriptMeasurement<T>(owner: object, calculate: (measurement: TranscriptMeasurement, shared: boolean) => T): T {
  const existing = active.get(owner);
  if (existing) return calculate(existing, true);
  const measurement = currentFrame(owner)?.measurement ?? new TranscriptMeasurement();
  measurement.validateRenderers();
  active.set(owner, measurement);
  try { return calculate(measurement, false); }
  finally { active.delete(owner); }
}
