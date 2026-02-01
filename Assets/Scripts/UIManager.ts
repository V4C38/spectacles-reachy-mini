import animate from "SpectaclesInteractionKit.lspkg/Utils/animate";
import { RoundButton } from "SpectaclesUIKit.lspkg/Scripts/Components/Button/RoundButton";
import { RectangleButton } from "SpectaclesUIKit.lspkg/Scripts/Components/Button/RectangleButton";
import { ReachyMiniManager } from "./ReachyMiniManager";

@component
export class UIManager extends BaseScriptComponent {

    @input
    private reachyMiniManager : ReachyMiniManager | null = null;

    private currentMode : number = 0;
    @input
    private textStateInidcator : Text | null = null;

    @input
    private uiContainer : SceneObject | null = null;
    @input
    private uiContainerMode1 : SceneObject | null = null;
    @input
    private uiContainerMode2 : SceneObject | null = null;

    @input
    private buttonEnable : RoundButton | null = null;
    @input
    private buttonEnableVFX : SceneObject | null = null;
    @input
    private buttonMode1 : RectangleButton | null = null;
    @input
    private buttonMode2 : RectangleButton | null = null;
    @input
    private buttonAllowRepositioning : RectangleButton | null = null;



    onAwake() {
        // Defer button subscription to OnStartEvent
        this.createEvent("OnStartEvent").bind(() => {
            if (this.buttonEnable && this.buttonEnable.onValueChange) {

                // Enable / Disable UI
                this.buttonEnable.onValueChange.add((value: number) => {
                    const isToggledOn = value === 1;
                    this.setUIState(isToggledOn ? 1 : 2);
                });

                // Set Mode
                this.buttonMode1.onTriggerUp.add((args: any) => {
                    this.setMode(1);
                });
                this.buttonMode2.onTriggerUp.add((args: any) => {
                    this.setMode(2);
                });
                this.buttonAllowRepositioning.onValueChange.add((value: number) => {
                    if (this.reachyMiniManager) {
                        this.reachyMiniManager.setPositioningEnabled(value === 1);
                    }
                });
            }
        });
    }

    // ------------------------------------------------------------
    // State
    // ------------------------------------------------------------
    public setMode(mode : number) {
        this.currentMode = mode;
        switch (mode) {
            case 1:
                if (this.buttonMode1 && this.buttonMode2) {
                    this.buttonMode1.isOn = true;     
                    this.buttonMode2.isOn = false;
                }
                if (this.uiContainerMode1 && this.uiContainerMode2) {   
                    this.uiContainerMode1.enabled = true;
                    this.uiContainerMode2.enabled = false;
                }
                if (this.reachyMiniManager) {
                    this.reachyMiniManager.setControlMode(1);
                }
                break;
            case 2:
                if (this.buttonMode1 && this.buttonMode2) {
                    this.buttonMode1.isOn = false;
                    this.buttonMode2.isOn = true;
                }
                if (this.uiContainerMode1 && this.uiContainerMode2) {
                    this.uiContainerMode1.enabled = false;
                    this.uiContainerMode2.enabled = true;
                }
                if (this.reachyMiniManager) {
                    this.reachyMiniManager.setControlMode(2);
                }
                break;
        }
    }

    // ------------------------------------------------------------
    // Show / Hide UI & Pause / Resume Interaction
    // ------------------------------------------------------------
    public setUIState(state : number) {

        switch (state) {
            case 0:
                if (this.uiContainer) {
                    this.uiContainer.enabled = false;
                }
                if (this.buttonEnable) {
                    this.buttonEnable.sceneObject.enabled = false;
                }
                break;
            case 1:
                if (this.uiContainer) {
                    this.animateSceneObjectState(this.uiContainer, false);
                }
                if (this.buttonEnable) {
                    this.buttonEnable.sceneObject.enabled = true;
                }
                if (this.buttonEnableVFX) {
                    this.animateSceneObjectState(this.buttonEnableVFX, true, 0.75);
                }
                if (this.buttonAllowRepositioning) {
                    this.buttonAllowRepositioning.toggle(false);
                }
                if (this.textStateInidcator) {
                    this.textStateInidcator.text = "Reachy Mini";
                }
                break;
            case 2:
                if (this.uiContainer) {
                    this.animateSceneObjectState(this.uiContainer, true);
                }
                if (this.buttonEnable) {
                    this.buttonEnable.sceneObject.enabled = true;
                }
                if (this.buttonEnableVFX) {
                    this.animateSceneObjectState(this.buttonEnableVFX, false, 1.0);
                }
                if (this.textStateInidcator) {
                    this.textStateInidcator.text = "- Paused -";
                }

                break;
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
