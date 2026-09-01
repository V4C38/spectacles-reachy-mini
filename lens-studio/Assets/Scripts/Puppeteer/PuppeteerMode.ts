import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import animate from "SpectaclesInteractionKit.lspkg/Utils/animate";
import { RobotDriver } from "../RobotDriver/RobotDriver";
import { PRESETS } from "../RobotDriver/RobotAnimationConfig";
import { getObjectLinkRenderer, ObjectLinkRenderer } from "../Utils/ObjectLinkRenderer";

//Puppeteer control mode: makes the robot look at a draggable target scene object.
@component
export class PuppeteerMode extends BaseScriptComponent {

    @input
    private robotDriver: RobotDriver | null = null;
    @input
    private interactable: Interactable | null = null;
    @input
    private interactableVFX: RenderMeshVisual | null = null;
    @input
    private interactableRoot: SceneObject | null = null;
    @input
    private lineRendererPrefab: ObjectPrefab | null = null;

    private lineObj: SceneObject | null = null;
    private lineRenderer: ObjectLinkRenderer | null = null;
    @input
    private lineRendererRoot: SceneObject | null = null;

    /** Current scale animation per object; only the animation for the same object is cancelled when starting a new one. */
    private sceneObjectStateAnimations: Map<SceneObject, ReturnType<typeof animate>> = new Map();

    onAwake() {
    }

    // ----------------------------------------------------------------
    // Mode lifecycle (called by ReachyMiniManager)----------------------------------------------------------------
    public reset(): void {
        if (this.robotDriver) {
            this.robotDriver.reset();
            this.robotDriver.setParams(PRESETS.puppeteer);
        }
    }

    public activate(): void {
        if (!this.interactable || !this.interactableRoot || !this.robotDriver) return;

        // Reset the interactable to its default position
        this.interactable.sceneObject.getTransform().setWorldPosition(
            this.interactableRoot.getTransform().getWorldPosition()
        );

        this.animateSceneObjectState(this.interactable.sceneObject, true, 0.75, new vec3(0.35, 0.35, 0.35));
        this.robotDriver.reset();
        this.robotDriver.setParams(PRESETS.puppeteer);
        this.robotDriver.resume();

        this.startHeadToInteractableLine();
    }

    public deactivate(): void {
        this.stopHeadToInteractableLine();
        if (this.interactable) {
            this.animateSceneObjectState(this.interactable.sceneObject, false, 0.4);
        }
        this.pause();
    }

    public pause(): void {
        if (this.robotDriver) this.robotDriver.pause();

        if (this.interactableVFX) {
            this.interactableVFX.mainPass["Saturation"] = 0;
        }
    }

    public resume(): void {
        if (this.robotDriver) this.robotDriver.resume();

        if (this.interactableVFX) {
            this.interactableVFX.mainPass["Saturation"] = 1;
        }
    }
    // ----------------------------------------------------------------
    // Update Loop
    // ----------------------------------------------------------------
    public update(): void {
        if (!this.robotDriver || !this.interactable) return;
        this.robotDriver.setGazeTarget(this.interactable.sceneObject.getTransform().getWorldPosition());
        this.updateHeadToInteractableLine();
    }


    // ----------------------------------------------------------------
    // Head-to-interactable line (ObjectLinkRenderer)
    // ----------------------------------------------------------------
    private startHeadToInteractableLine(): void {
        if (!this.lineRendererPrefab || !this.interactable || !this.lineRendererRoot) return;
        const headPos = this.lineRendererRoot.getTransform().getWorldPosition();
        const endPos = this.interactable.sceneObject.getTransform().getWorldPosition();
        this.lineObj = this.lineRendererPrefab.instantiate(null);
        this.lineObj.getTransform().setWorldPosition(headPos);
        this.lineRenderer = getObjectLinkRenderer(this.lineObj);
        if (!this.lineRenderer) {
            this.lineObj.destroy();
            this.lineObj = null;
            return;
        }
        this.lineRenderer.setLineAndAppear(headPos, endPos);
    }

    private updateHeadToInteractableLine(): void {
        if (!this.lineRenderer || !this.lineObj || !this.lineRendererRoot || !this.interactable) return;
        const headPos = this.lineRendererRoot.getTransform().getWorldPosition();
        const endPos = this.interactable.sceneObject.getTransform().getWorldPosition();
        this.lineObj.getTransform().setWorldPosition(headPos);
        this.lineRenderer.updateEndPosition(endPos);
    }

    private stopHeadToInteractableLine(): void {
        if (!this.lineRenderer) return;
        const renderer = this.lineRenderer;
        this.lineObj = null;
        this.lineRenderer = null;
        renderer.destroy();
    }

    // ----------------------------------------------------------------
    // Helpers
    // ----------------------------------------------------------------
    private animateSceneObjectState(sceneObject: SceneObject, state: boolean, duration: number = 0.5, scale: vec3 = new vec3(1, 1, 1)): Promise<void> {
        const existing = this.sceneObjectStateAnimations.get(sceneObject);
        if (existing) {
            existing();
            this.sceneObjectStateAnimations.delete(sceneObject);
        }
        if (state) {
            sceneObject.enabled = true;
        }
        const startScale = state ? new vec3(0, 0, 0) : scale;
        const targetScale = state ? scale : new vec3(0, 0, 0);
        return new Promise<void>((resolve) => {
            const anim = animate({
                duration: duration,
                easing: "ease-in-out-quad",
                update: (t: number) => {
                    const x = startScale.x + (targetScale.x - startScale.x) * t;
                    const y = startScale.y + (targetScale.y - startScale.y) * t;
                    const z = startScale.z + (targetScale.z - startScale.z) * t;
                    sceneObject.getTransform().setLocalScale(new vec3(x, y, z));
                },
                ended: () => {
                    this.sceneObjectStateAnimations.delete(sceneObject);
                    if (!state) {
                        sceneObject.enabled = false;
                    }
                    resolve();
                },
            });
            this.sceneObjectStateAnimations.set(sceneObject, anim);
        });
    }
}
