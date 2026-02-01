import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import { DaemonInterface } from "./DaemonInterface";
import animate from "SpectaclesInteractionKit.lspkg/Utils/animate";

@component
export class ReachyMiniManager extends BaseScriptComponent {

    @input
    private reachyMiniRoot : SceneObject | null = null;

    @input
    private daemonInterface : DaemonInterface | null = null;

    // State
    private isActive : boolean = false;


    // Positioning
    @input
    private positioningHologram : SceneObject | null = null;
    @input
    private positioningInteraction : Interactable | null = null;

    // Control Modes
    private controlMode : number = 0;

    @input
    private mode1Interactable : Interactable | null = null;
    @input
    private mode1InteractableRoot : SceneObject | null = null;



    onAwake() {

        // Defer button subscription to OnStartEvent
        this.createEvent("OnStartEvent").bind(() => {
            this.setPositioningEnabled(false);
            this.setControlMode(0);
        });

    }

    // ------------------------------------------------------------
    // Is Active
    // ------------------------------------------------------------
    public setIsActive(isActive : boolean) {
        this.isActive = isActive;
    }

    // ------------------------------------------------------------
    // ControlMode
    // ------------------------------------------------------------
    public setControlMode(mode : number) {
        this.controlMode = mode;
        switch (mode) {
            case 0:
                this.setControlMode0();
                break;
            case 1:
                this.setControlMode1();
                break;
            case 2:
                this.setControlMode2();
                break;
        }
    }

    private setControlMode0() {
        if (this.mode1Interactable) {
            this.mode1Interactable.sceneObject.enabled = false;
        }
    }

    private setControlMode1() {
        if (this.mode1Interactable && this.mode1InteractableRoot) {
            // Set location of the interactable to the center of the root
            this.mode1Interactable.sceneObject.getTransform().setWorldPosition(this.mode1InteractableRoot.getTransform().getWorldPosition());
            this.animateSceneObjectState(this.mode1Interactable.sceneObject, true);
        }
    }

    private setControlMode2() {
        if (this.mode1Interactable) {
            this.animateSceneObjectState(this.mode1Interactable.sceneObject, false);
        }
    }

    // ------------------------------------------------------------
    // Positioning
    // ------------------------------------------------------------
    public setRootPosition(position : vec3, rotation : quat = new quat(0, 0, 0, 0)) {
        if (this.reachyMiniRoot) {
            this.reachyMiniRoot.getTransform().setWorldPosition(position);
            this.reachyMiniRoot.getTransform().setWorldRotation(rotation);
        }
    }

    public setPositioningEnabled(enabled : boolean) {
        if (this.positioningHologram) {
            this.animateSceneObjectState(this.positioningHologram, enabled);
        }
        if (this.positioningInteraction) {
            this.positioningInteraction.enabled = enabled;
        }
    }


    // ------------------------------------------------------------
    // Helper functions
    // ------------------------------------------------------------
    private animateSceneObjectState(sceneObject : SceneObject, state : boolean, duration : number = 0.5): Promise<void> {
        // Enable before animating in, disable after animating out
        if (state) {
            sceneObject.enabled = true;
        }
        const startScale = state ? new vec3(0, 0, 0) : new vec3(1, 1, 1);
        const targetScale = state ? new vec3(1, 1, 1) : new vec3(0, 0, 0);
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
