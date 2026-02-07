import animate from "SpectaclesInteractionKit.lspkg/Utils/animate";


// This is some vibecoded slop because the LensStudio line renderer needs some material and doesn't work


// ================================================================
// Shared geometry constants
// ================================================================

const LINE_WIDTH_START = 0.02;
const LINE_WIDTH_MID = 0.15;
const CURVE_HEIGHT_RATIO = 0.1;
const CURVE_SEGMENTS = 20;
const APPEAR_DURATION = 0.25;
const DISAPPEAR_DURATION = 0.25;
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

function getMeshAlpha(meshVisual: RenderMeshVisual): number {
    const pass = meshVisual.mainPass;
    if (pass.baseColor === undefined) {
        return 0;
    }
    return pass.baseColor.w;
}

// ================================================================
// Factory function for runtime line creation
// ================================================================

/**
 * Handle returned by createCurvedLine for controlling the line's lifecycle.
 */
export interface CurvedLineHandle {
    /** Fade the line out. */
    disappear: () => void;
    /** Immediately destroy the scene object. */
    destroy: () => void;
}

/**
 * Create a curved line between two world-space positions at runtime.
 * The line fades in automatically. Call handle.disappear() to fade out,
 * then handle.destroy() to remove the scene object.
 */
export function createCurvedLine(
    start: vec3,
    end: vec3,
    material: Material
): CurvedLineHandle {
    // Create scene object positioned at start
    const obj = global.scene.createSceneObject("CurvedLine");
    obj.getTransform().setWorldPosition(start);

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
    } else {
        print("createCurvedLine: Mesh validation failed");
    }

    // Start transparent, then fade in
    setMeshAlpha(meshVisual, 0);

    let currentAnimation: any = null;
    let isAnimating = false;

    // Fade in
    currentAnimation = animate({
        duration: APPEAR_DURATION,
        easing: "ease-in-out-quad",
        update: (t: number) => {
            setMeshAlpha(meshVisual, t);
        },
        ended: () => {
            isAnimating = false;
            currentAnimation = null;
        }
    });
    isAnimating = true;

    const handle: CurvedLineHandle = {
        disappear: () => {
            if (isAnimating && currentAnimation) {
                currentAnimation.cancel();
            }
            isAnimating = true;
            const startAlpha = getMeshAlpha(meshVisual);
            currentAnimation = animate({
                duration: DISAPPEAR_DURATION,
                easing: "ease-in-out-quad",
                update: (t: number) => {
                    setMeshAlpha(meshVisual, startAlpha * (1 - t));
                },
                ended: () => {
                    isAnimating = false;
                    currentAnimation = null;
                }
            });
        },
        destroy: () => {
            if (isAnimating && currentAnimation) {
                currentAnimation.cancel();
            }
            obj.destroy();
        }
    };

    return handle;
}

// ================================================================
// Component version (for use on prefabs like ObjectMarker)
// ================================================================

/**
 * Component that renders a curved line from this scene object to a target position.
 * The line appears with an animation when the component is added to the scene.
 * 
 * For runtime creation without a component, use createCurvedLine() instead.
 */
@component
export class ObjectLinkRenderer extends BaseScriptComponent {
    
    @input
    public endPosition: vec3 = new vec3(0, 0, 0.1);
    
    @input
    public material: Material | null = null;
    
    // --- Private State ---
    private meshVisual: RenderMeshVisual | null = null;
    private meshBuilder: MeshBuilder | null = null;
    private isVisible: boolean = false;
    private isAnimating: boolean = false;
    private currentAnimation: any = null;
    
    onAwake() {
        if (!this.material) {
            print("ObjectLinkRenderer: material is required");
            return;
        }
        
        const start = this.sceneObject.getTransform().getWorldPosition();
        print(`ObjectLinkRenderer: Start=${start}, End=${this.endPosition}, Distance=${start.distance(this.endPosition)}`);
        
        this.setupMesh();
        this.appear();
    }
    
    public appear(): void {
        if (!this.meshVisual) return;
        if (this.isAnimating && this.currentAnimation) {
            this.currentAnimation.cancel();
        }
        
        this.isAnimating = true;
        this.isVisible = true;
        
        const startAlpha = getMeshAlpha(this.meshVisual);
        const mv = this.meshVisual;
        this.currentAnimation = animate({
            duration: APPEAR_DURATION,
            easing: "ease-in-out-quad",
            update: (t: number) => {
                setMeshAlpha(mv, startAlpha + (1 - startAlpha) * t);
            },
            ended: () => {
                this.isAnimating = false;
                this.currentAnimation = null;
            }
        });
    }
    
    public disappear(): void {
        if (!this.meshVisual) return;
        if (this.isAnimating && this.currentAnimation) {
            this.currentAnimation.cancel();
        }
        
        this.isAnimating = true;
        
        const startAlpha = getMeshAlpha(this.meshVisual);
        const mv = this.meshVisual;
        this.currentAnimation = animate({
            duration: DISAPPEAR_DURATION,
            easing: "ease-in-out-quad",
            update: (t: number) => {
                setMeshAlpha(mv, startAlpha * (1 - t));
            },
            ended: () => {
                this.isVisible = false;
                this.isAnimating = false;
                this.currentAnimation = null;
            }
        });
    }
    
    public updateEndPosition(end: vec3): void {
        this.endPosition = end;
        this.rebuildLine();
    }
    
    // --- Private Methods ---
    
    private setupMesh(): void {
        this.meshVisual = this.sceneObject.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        this.meshVisual.mainMaterial = this.material;
        
        this.meshBuilder = createLineMeshBuilder([], []);
        
        this.rebuildLine();
        
        if (this.meshBuilder.isValid()) {
            this.meshVisual.mesh = this.meshBuilder.getMesh();
        } else {
            print("ObjectLinkRenderer: Mesh is not valid after initial build");
        }
    }
    
    private rebuildLine(): void {
        if (!this.meshBuilder || !this.meshVisual) return;
        
        const localStart = new vec3(0, 0, 0);
        const transform = this.sceneObject.getTransform();
        const localEnd = transform.getInvertedWorldTransform().multiplyPoint(this.endPosition);
        
        const worldStart = transform.getWorldPosition();
        print(`ObjectLinkRenderer: WorldStart=${worldStart}, WorldEnd=${this.endPosition}, LocalEnd=${localEnd}`);
        
        const control = computeControlPoint(localStart, localEnd, CURVE_HEIGHT_RATIO);
        const points = sampleQuadraticBezier(localStart, control, localEnd, CURVE_SEGMENTS);
        
        print(`ObjectLinkRenderer: First point=${points[0]}, Last point=${points[points.length - 1]}`);
        
        // Clear existing data
        const vertCount = this.meshBuilder.getVerticesCount();
        if (vertCount > 0) {
            this.meshBuilder.eraseVertices(0, vertCount);
        }
        const indexCount = this.meshBuilder.getIndicesCount();
        if (indexCount > 0) {
            this.meshBuilder.eraseIndices(0, indexCount);
        }
        
        const { verts, indices } = buildLineGeometry(points);
        this.meshBuilder.appendVerticesInterleaved(verts);
        this.meshBuilder.appendIndices(indices);
        
        if (!this.meshBuilder.isValid()) {
            print("ObjectLinkRenderer: Mesh validation failed");
            return;
        }
        
        this.meshBuilder.updateMesh();
    }
}
