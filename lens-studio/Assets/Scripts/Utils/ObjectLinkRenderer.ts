// The LensStudio line renderer needs some material I don´t know how to setup and thus doesn't work so we use this instead. 


// ================================================================
// Shared geometry constants
// ================================================================

const LINE_WIDTH_START = 0.25;
const LINE_WIDTH_MID = 1.5;
const CURVE_HEIGHT_RATIO = 0.1;
const CURVE_SEGMENTS = 15;
const DEFAULT_COLOR = new vec4(1, 1, 1, 1);

// ================================================================
// Module-level geometry helpers
// ================================================================

function computeControlPoint(start: vec3, end: vec3, heightRatio: number): vec3 {
    const delta = end.sub(start);
    const dist = delta.length;
    if (dist <= 0.001) {
        return start;
    }
    const midpoint = start.add(delta.uniformScale(0.5));
    const curveHeight = dist * heightRatio;
    return midpoint.add(new vec3(0, curveHeight, 0));
}

function sampleQuadraticBezier(start: vec3, control: vec3, end: vec3, segments: number): vec3[] {
    const points: vec3[] = [];
    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const oneMinus = 1 - t;
        const p = start.uniformScale(oneMinus * oneMinus)
            .add(control.uniformScale(2 * oneMinus * t))
            .add(end.uniformScale(t * t));
        points.push(p);
    }
    return points;
}

function computeTangent(points: vec3[], index: number): vec3 {
    if (points.length < 2) {
        return new vec3(0, 0, 1);
    }
    if (index === 0) {
        return points[1].sub(points[0]).normalize();
    }
    if (index === points.length - 1) {
        return points[index].sub(points[index - 1]).normalize();
    }
    return points[index + 1].sub(points[index - 1]).normalize();
}

/**
 * Build interleaved vertex and index data for a curved line strip.
 */
function buildLineGeometry(points: vec3[]): { verts: number[]; indices: number[] } {
    const verts: number[] = [];
    const indices: number[] = [];
    const up = new vec3(0, 1, 0);

    for (let i = 0; i < points.length; i++) {
        const t = points.length > 1 ? i / (points.length - 1) : 0;

        // Width tapering: thin at ends, thick in middle
        const taper = 1.0 - Math.abs(2.0 * t - 1.0);
        const width = LINE_WIDTH_START + (LINE_WIDTH_MID - LINE_WIDTH_START) * taper;

        const tangent = computeTangent(points, i);
        let side = tangent.cross(up);
        if (side.length <= 0.0001) {
            side = tangent.cross(new vec3(1, 0, 0));
        }
        side = side.normalize();
        const normal = side.cross(tangent).normalize();

        const left = points[i].add(side.uniformScale(width * 0.5));
        const right = points[i].sub(side.uniformScale(width * 0.5));

        // Left vertex: position(3) + normal(3) + uv(2) + color(4)
        verts.push(
            left.x, left.y, left.z,
            normal.x, normal.y, normal.z,
            t, 0,
            DEFAULT_COLOR.x, DEFAULT_COLOR.y, DEFAULT_COLOR.z, DEFAULT_COLOR.w
        );

        // Right vertex
        verts.push(
            right.x, right.y, right.z,
            normal.x, normal.y, normal.z,
            t, 1,
            DEFAULT_COLOR.x, DEFAULT_COLOR.y, DEFAULT_COLOR.z, DEFAULT_COLOR.w
        );
    }

    for (let i = 0; i < points.length - 1; i++) {
        const a = i * 2;
        const b = i * 2 + 1;
        const c = (i + 1) * 2;
        const d = (i + 1) * 2 + 1;
        indices.push(a, c, b);
        indices.push(b, c, d);
    }

    return { verts, indices };
}

/**
 * Create a MeshBuilder configured for line rendering and populate it
 * with the given geometry data.
 */
function createLineMeshBuilder(verts: number[], indices: number[]): MeshBuilder {
    const mb = new MeshBuilder([
        { name: "position", components: 3 },
        { name: "normal", components: 3 },
        { name: "texture0", components: 2 },
        { name: "color", components: 4 }
    ]);
    mb.topology = MeshTopology.Triangles;
    mb.indexType = MeshIndexType.UInt16;
    mb.appendVerticesInterleaved(verts);
    mb.appendIndices(indices);
    return mb;
}

// ================================================================
// Shared alpha helpers
// ================================================================

function setMeshAlpha(meshVisual: RenderMeshVisual, alpha: number): void {
    const pass = meshVisual.mainPass;
    if (pass.baseColor === undefined) {
        print("ObjectLinkRenderer: material must define mainPass.baseColor");
        return;
    }
    pass.baseColor = new vec4(DEFAULT_COLOR.x, DEFAULT_COLOR.y, DEFAULT_COLOR.z, alpha);
}

// ================================================================
// Factory function for runtime line creation
// ================================================================

/**
 * Handle returned by createCurvedLine for controlling the line's lifecycle.
 */
export interface CurvedLineHandle {
    /** Destroy the line and remove it from the scene. */
    destroy: () => void;
}

/**
 * Create a curved line between two world-space positions at runtime.
 * The line is shown immediately. Call handle.destroy() to remove it.
 */
export function createCurvedLine(
    start: vec3,
    end: vec3,
    material: Material
): CurvedLineHandle {
    // Create scene object positioned at start
    const obj = global.scene.createSceneObject("CurvedLine");
    obj.getTransform().setWorldPosition(start);
    obj.layer = LayerSet.fromNumber(1);

    // Create RenderMeshVisual
    const meshVisual = obj.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    meshVisual.mainMaterial = material;

    // Build geometry in local space
    const localEnd = obj.getTransform().getInvertedWorldTransform().multiplyPoint(end);
    const localStart = new vec3(0, 0, 0);
    const control = computeControlPoint(localStart, localEnd, CURVE_HEIGHT_RATIO);
    const points = sampleQuadraticBezier(localStart, control, localEnd, CURVE_SEGMENTS);
    const { verts, indices } = buildLineGeometry(points);

    const mb = createLineMeshBuilder(verts, indices);
    if (mb.isValid()) {
        meshVisual.mesh = mb.getMesh();
        mb.updateMesh();
    } else {
        print("createCurvedLine: Mesh validation failed");
    }

    setMeshAlpha(meshVisual, 1);

    let isDestroyed = false;

    const handle: CurvedLineHandle = {
        destroy: () => {
            if (isDestroyed) return;
            isDestroyed = true;
            obj.destroy();
        }
    };

    return handle;
}

// ================================================================
// Helper for finding ObjectLinkRenderer on a spawned prefab
// ================================================================

/**
 * Find the ObjectLinkRenderer component on the given scene object or any of its children.
 * Use this after instantiating a line prefab to get the component for setLineAndAppear.
 */
export function getObjectLinkRenderer(sceneObject: SceneObject): ObjectLinkRenderer | null {
    const comp = sceneObject.getComponent("Component.ScriptComponent") as BaseScriptComponent;
    if (comp && comp instanceof ObjectLinkRenderer) {
        return comp as ObjectLinkRenderer;
    }
    const childCount = sceneObject.getChildrenCount();
    for (let i = 0; i < childCount; i++) {
        const found = getObjectLinkRenderer(sceneObject.getChild(i));
        if (found) return found;
    }
    return null;
}

// ================================================================
// Component version (for use on prefabs like ObjectMarker)
// ================================================================

/**
 * Component that renders a curved line from this scene object to a target position.
 * The line is shown immediately when appear() is called (or on setLineAndAppear).
 *
 * For runtime creation without a component, use createCurvedLine() instead.
 */
@component
export class ObjectLinkRenderer extends BaseScriptComponent {

    @input
    public endPosition: vec3 = new vec3(0, 0, 0.1);

    @input
    public material: Material | null = null;

    /** If true, call appear() in onAwake (for designer-placed prefabs). Set false on prefabs used for runtime spawn so setLineAndAppear controls when the line shows. */
    @input
    public autoAppearOnAwake: boolean = false;

    // --- Private State ---
    /** Child scene object that holds the line mesh. The component's scene object is only the start-position holder. */
    private meshChild: SceneObject | null = null;
    private meshVisual: RenderMeshVisual | null = null;
    private meshBuilder: MeshBuilder | null = null;
    private isVisible: boolean = false;
    
    onAwake() {
        if (!this.material) {
            print("ObjectLinkRenderer: material is required");
            return;
        }
        this.setupMesh();
        if (this.autoAppearOnAwake) {
            this.rebuildLine();
            this.appear();
        }
    }

    /**
     * Set line once: prefab (holder) at startWorld, line to endWorld (both world space).
     * Builds geometry once. Call after spawning prefab at start.
     */
    public setLineAndAppear(startWorld: vec3, endWorld: vec3): void {
        this.getSceneObject().getTransform().setWorldPosition(startWorld);
        this.endPosition = endWorld;
        this.rebuildLine();
        this.appear();
    }
    
    public appear(): void {
        if (!this.meshVisual) return;
        this.isVisible = true;
        this.meshVisual.enabled = true;
        setMeshAlpha(this.meshVisual, 1);
    }

    /** Destroy the line (removes this scene object from the scene). */
    public destroy(): void {
        this.getSceneObject().destroy();
    }

    public updateEndPosition(end: vec3): void {
        this.endPosition = end;
        this.rebuildLine();
    }
    
    // --- Private Methods ---
    
    private setupMesh(): void {
        // Geometry on a child; this.sceneObject is only the start-position holder.
        this.meshChild = global.scene.createSceneObject("LineMesh");
        this.meshChild.setParent(this.sceneObject);
        this.meshChild.getTransform().setLocalPosition(new vec3(0, 0, 0));

        this.meshVisual = this.meshChild.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        this.meshVisual.mainMaterial = this.material;
        this.meshBuilder = createLineMeshBuilder([], []);
    }

    /**
     * Build line once: from holder world position (start) to endPosition (world).
     * Not called every frame.
     */
    private rebuildLine(): void {
        if (!this.meshBuilder || !this.meshVisual) return;

        const transform = this.sceneObject.getTransform();
        const localStart = new vec3(0, 0, 0);
        const localEnd = transform.getInvertedWorldTransform().multiplyPoint(this.endPosition);

        const control = computeControlPoint(localStart, localEnd, CURVE_HEIGHT_RATIO);
        const points = sampleQuadraticBezier(localStart, control, localEnd, CURVE_SEGMENTS);

        const vertCount = this.meshBuilder.getVerticesCount();
        if (vertCount > 0) this.meshBuilder.eraseVertices(0, vertCount);
        const indexCount = this.meshBuilder.getIndicesCount();
        if (indexCount > 0) this.meshBuilder.eraseIndices(0, indexCount);

        const { verts, indices } = buildLineGeometry(points);
        this.meshBuilder.appendVerticesInterleaved(verts);
        this.meshBuilder.appendIndices(indices);

        if (!this.meshBuilder.isValid()) return;
        this.meshBuilder.updateMesh();
        this.meshVisual.mesh = this.meshBuilder.getMesh();
    }
}
