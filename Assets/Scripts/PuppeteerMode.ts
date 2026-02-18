import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import animate from "SpectaclesInteractionKit.lspkg/Utils/animate";
import { RobotDriver, PROFILES } from "./RobotDriver";

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

    onAwake() {
    }

    // ----------------------------------------------------------------
    // Mode lifecycle (called by ReachyMiniManager)
    // Enter puppeteer mode: reset position, show interactable, configure driver
    // ----------------------------------------------------------------
    public reset(): void {
        if (this.robotDriver) {
            this.robotDriver.reset();
            this.robotDriver.setProfile(PROFILES.puppeteer);
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
        this.robotDriver.setProfile(PROFILES.puppeteer);
    }

    public deactivate(): void {
        if (this.interactable) {
            this.animateSceneObjectState(this.interactable.sceneObject, false, 0.4);
        }
        this.pause();
    }

    public pause(): void {
        if (this.robotDriver) this.robotDriver.pause();
    }

    public resume(): void {
        if (this.robotDriver) this.robotDriver.resume();
    }
    // ----------------------------------------------------------------
    // Update Loop
    // ----------------------------------------------------------------
    public update(): void {
        if (!this.robotDriver || !this.interactable) return;
        this.robotDriver.lookAt(this.interactable.sceneObject.getTransform().getWorldPosition());
        this.robotDriver.updateFrame();
    }


    // ----------------------------------------------------------------
    // Helpers
    // ----------------------------------------------------------------
    private animateSceneObjectState(sceneObject: SceneObject, state: boolean, duration: number = 0.5, scale: vec3 = new vec3(1, 1, 1)): Promise<void> {
        if (state) {
            sceneObject.enabled = true;
        }
        const startScale = state ? new vec3(0, 0, 0) : scale;
        const targetScale = state ? scale : new vec3(0, 0, 0);
        return new Promise<void>((resolve) => {
            animate({
                duration: duration,
                easing: "ease-in-out-quad",
                update: (t: number) => {
                    const x = startScale.x + (targetScale.x - startScale.x) * t;
                    const y = startScale.y + (targetScale.y - startScale.y) * t;
                    const z = startScale.z + (targetScale.z - startScale.z) * t;
                    sceneObject.getTransform().setLocalScale(new vec3(x, y, z));
                },
                ended: () => {
                    if (!state) {
                        sceneObject.enabled = false;
                    }
                    resolve();
                },
            });
        });
    }
}
