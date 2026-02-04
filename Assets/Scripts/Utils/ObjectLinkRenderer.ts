import LineRenderer from "SpectaclesInteractionKit.lspkg/Utils/views/LineRenderer/LineRenderer";

@component
export class ObjectLinkRenderer extends BaseScriptComponent {
    @input
    targetObject: SceneObject | null = null;

    @input
    lineMaterial: Material | null = null;

    @input
    lineColor: vec4 = new vec4(1, 1, 1, 1);

    @input
    lineWidth: number = 5.0;

    @input
    fadeToEnd: boolean = true;

    private lineRenderer: LineRenderer | null = null;
    private lineContainer: SceneObject | null = null;

    onAwake() {
        this.createEvent("OnStartEvent").bind(() => this.initialize());
    }

    private initialize() {
        if (!this.targetObject) {
            throw new Error("ObjectLinkRenderer: targetObject is required");
        }
        if (!this.lineMaterial) {
            throw new Error("ObjectLinkRenderer: lineMaterial is required");
        }

        // Create a separate container at world origin for the line
        this.lineContainer = global.scene.createSceneObject("LineContainer");
        
        const startColor = this.lineColor;
        const endColor = this.fadeToEnd
            ? new vec4(this.lineColor.x, this.lineColor.y, this.lineColor.z, 0)
            : this.lineColor;

        this.lineRenderer = new LineRenderer({
            material: this.lineMaterial,
            points: [vec3.zero(), vec3.one()],
            startColor: startColor,
            endColor: endColor,
            startWidth: this.lineWidth,
            endWidth: this.lineWidth,
        });
        this.lineRenderer.attachToScene(this.lineContainer);
        
        // Debug: Check what parameters the material actually has
        print("ObjectLinkRenderer: Material mainPass properties:");
        try {
            const props = Object.keys(this.lineMaterial.mainPass);
            print("  Available properties: " + props.join(", "));
            
            // Try to read back the values that LineRenderer set
            if (this.lineMaterial.mainPass.startColor !== undefined) {
                print("  startColor is supported: " + this.lineMaterial.mainPass.startColor);
            } else {
                print("  ERROR: startColor NOT supported by material!");
            }
            if (this.lineMaterial.mainPass.endColor !== undefined) {
                print("  endColor is supported: " + this.lineMaterial.mainPass.endColor);
            } else {
                print("  ERROR: endColor NOT supported by material!");
            }
        } catch (e) {
            print("  Error checking material: " + e);
        }

        print("ObjectLinkRenderer: Line initialized, width=" + this.lineWidth + ", color=" + this.lineColor);
        
        this.createEvent("UpdateEvent").bind(() => this.updateLine());
    }

    private updateLine() {
        if (!this.lineRenderer || !this.targetObject || !this.lineContainer) return;

        const startPos = this.sceneObject.getTransform().getWorldPosition();
        const endPos = this.targetObject.getTransform().getWorldPosition();
        this.lineRenderer.points = [startPos, endPos];

    }
    
    onDestroy() {
        if (this.lineRenderer && this.lineContainer) {
            this.lineRenderer.destroy();
            this.lineContainer.destroy();
        }
    }
}
