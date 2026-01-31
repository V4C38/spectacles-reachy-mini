import animate from "SpectaclesInteractionKit.lspkg/Utils/animate";
import { RoundButton } from "SpectaclesUIKit.lspkg/Scripts/Components/Button/RoundButton";
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";

@component
export class UIManager extends BaseScriptComponent {


    private isActive : boolean = false;

    @input
    private uiContainer : SceneObject | null = null;
    @input
    private robotHologram : SceneObject | null = null;
    @input
    private positioningInteraction : Interactable | null = null;

    @input
    private buttonEnable : RoundButton | null = null;
    @input
    private buttonEnableVFX : SceneObject | null = null;


    onAwake() {
        // Defer button subscription to OnStartEvent so RoundButton has finished its own initialization
        this.createEvent("OnStartEvent").bind(() => {
            if (this.buttonEnable && this.buttonEnable.onValueChange) {
                // onValueChange fires with 1 when on, 0 when off
                this.buttonEnable.onValueChange.add((value: number) => {
                    const isToggledOn = value === 1;
                    this.onSetActive(isToggledOn);
                });
            }
        });
    }

    public onSetActive(active : boolean) {
        this.isActive = active;
        if (active) {
            this.onActivate();
        } else {
            this.onDeactivate();
        }
    }

    private onActivate() {
        if (this.uiContainer) {
            this.animateSceneObjectState(this.uiContainer, false);
        }
        if (this.robotHologram) {
            this.animateSceneObjectState(this.robotHologram, false);
        }
        if (this.buttonEnableVFX) {
            this.animateSceneObjectState(this.buttonEnableVFX, true, 0.75);
        }
        if (this.positioningInteraction) {
            this.positioningInteraction.enabled = false;
        }
    }

    private onDeactivate() {
        if (this.uiContainer) {
            this.animateSceneObjectState(this.uiContainer, true);
        }
        if (this.robotHologram) {
            this.animateSceneObjectState(this.robotHologram, true);
        }
        if (this.buttonEnableVFX) {
            this.animateSceneObjectState(this.buttonEnableVFX, false, 1.0);
        }
        if (this.positioningInteraction) {
            this.positioningInteraction.enabled = true;
        }
    }

    private animateSceneObjectState(sceneObject : SceneObject, state : boolean, duration : number = 0.5): Promise<void> {
        // Enable before animating in, disable after animating out
        if (state) {
            sceneObject.enabled = true;
        }

        // if boolean is true set scale to 0,0,0 else to 1,1,1
        const startScale = state ? new vec3(0, 0, 0) : new vec3(1, 1, 1);
        const targetScale = state ? new vec3(1, 1, 1) : new vec3(0, 0, 0);

        // animate the scale from startScale to targetScale
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
