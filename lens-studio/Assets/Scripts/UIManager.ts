import animate from "SpectaclesInteractionKit.lspkg/Utils/animate";
import { RoundButton } from "SpectaclesUIKit.lspkg/Scripts/Components/Button/RoundButton";
import { RectangleButton } from "SpectaclesUIKit.lspkg/Scripts/Components/Button/RectangleButton";
import { ReachyMiniManager } from "./ReachyMiniManager";
import { AssistantState } from "./Assistant/AssistantMode";


@component
export class UIManager extends BaseScriptComponent {

    @input
    private reachyMiniManager: ReachyMiniManager | null = null;

    private currentMode: number = 0;
    /** 0=hidden, 1=active (listening), 2=paused (UI open). Used so assistant callbacks don't overwrite "- Paused -". */
    private currentUIState: number = 0;
    @input
    private textStateInidcator: Text | null = null;
    @input
    private textConnectionStatus: Text | null = null;

    @input
    private uiContainer: SceneObject | null = null;
    @input
    private uiContainerMode1: SceneObject | null = null;
    @input
    private uiContainerMode2: SceneObject | null = null;

    @input
    private buttonEnable: RoundButton | null = null;
    @input
    private buttonEnableVFX: SceneObject | null = null;
    @input
    private buttonEnableVFX2: SceneObject | null = null;
    @input
    private buttonMode1: RectangleButton | null = null;
    @input
    private buttonMode2: RectangleButton | null = null;
    @input
    private buttonAllowRepositioning: RectangleButton | null = null;


    @input
    private audioPlayerBackground: AudioComponent | null = null;

    @input
    private buttonShowDebugInfo: RectangleButton | null = null;
    @input
    private textDebugInfo: Text | null = null;



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

                // Debug Info
                this.buttonShowDebugInfo.onValueChange.add((value: number) => {
                    this.textDebugInfo.sceneObject.enabled = value === 1;
                });
            }

            // Subscribe to assistant state & session changes via facade
            if (this.reachyMiniManager) {
                this.reachyMiniManager.onAssistantStateChanged.push((newState: AssistantState) => {
                    if (!this.textStateInidcator || this.reachyMiniManager.controlMode !== 2 || this.currentUIState !== 1) return;
                    if (newState === AssistantState.Sleeping) {
                        this.textStateInidcator.text = "Say 'Reachy' to wake up";
                    }
                });

                this.reachyMiniManager.onSessionChanged.push((active: boolean) => {
                    if (!this.textStateInidcator || this.reachyMiniManager.controlMode !== 2 || this.currentUIState !== 1) return;
                    this.textStateInidcator.text = active ? "Reachy" : "Say 'Reachy' to wake up";
                });
                this.reachyMiniManager.onDebugForceShow.push(() => this.forceShowDebugPanel());
            }
        });
    }

    // ------------------------------------------------------------
    // Debug Panel
    // ------------------------------------------------------------
    public forceShowDebugPanel(): void {
        if (this.textDebugInfo) {
            this.textDebugInfo.sceneObject.enabled = true;
        }
        if (this.buttonShowDebugInfo && (this.buttonShowDebugInfo as any).toggle) {
            (this.buttonShowDebugInfo as any).toggle(true);
        } else if (this.buttonShowDebugInfo && (this.buttonShowDebugInfo as any).isOn !== undefined) {
            (this.buttonShowDebugInfo as any).isOn = true;
        }
    }

    // ------------------------------------------------------------
    // State
    // ------------------------------------------------------------
    public setMode(mode: number) {
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
    public setUIState(state: number) {
        this.currentUIState = state;
        switch (state) {
            case 0:
                if (this.uiContainer) {
                    this.uiContainer.enabled = false;
                }
                if (this.buttonEnable) {
                    this.buttonEnable.sceneObject.enabled = false;
                }
                if (this.audioPlayerBackground) {
                    this.audioPlayerBackground.stop(true);
                }
                break;
            case 1:
                if (this.uiContainer) {
                    this.uiContainer.enabled = false;
                }
                if (this.buttonEnable && this.buttonEnableVFX) {
                    this.buttonEnable.sceneObject.enabled = true;
                    this.animateSceneObjectState(this.buttonEnableVFX, true, 0.75);
                    this.animateSceneObjectState(this.buttonEnableVFX2, false);
                }
                if (this.buttonAllowRepositioning) {
                    this.buttonAllowRepositioning.toggle(false);
                }
                if (this.textStateInidcator && this.reachyMiniManager) {
                    if (this.reachyMiniManager.controlMode === 2) {
                        if (this.reachyMiniManager.isConversationActive) {
                            this.textStateInidcator.text = "Reachy";
                        } else {
                            this.textStateInidcator.text = "Say 'Reachy' to wake up";
                        }
                    } else {
                        this.textStateInidcator.text = "Reachy";
                    }
                }
                if (this.reachyMiniManager) {
                    this.reachyMiniManager.setIsActive(true);
                }
                if (this.audioPlayerBackground) {
                    this.audioPlayerBackground.stop(true);
                }
                break;
            case 2:
                if (this.uiContainer) {
                    this.uiContainer.enabled = true;
                }
                if (this.buttonEnable && this.buttonEnableVFX) {
                    this.buttonEnable.sceneObject.enabled = true;
                    this.animateSceneObjectState(this.buttonEnableVFX, false, 1.0);
                    this.animateSceneObjectState(this.buttonEnableVFX2, true, 0.75);
                }
                if (this.textStateInidcator) {
                    this.textStateInidcator.text = "- Paused -";
                }
                if (this.reachyMiniManager) {
                    this.reachyMiniManager.setIsActive(false);
                }
                if (this.audioPlayerBackground) {
                    this.audioPlayerBackground.play(999);
                }
                // Update connection status via facade
                if (this.reachyMiniManager) {
                    if (this.reachyMiniManager.isSimulationMode) {
                        this.textConnectionStatus.text = "Simulation Mode";
                        this.textConnectionStatus.textFill.color = new vec4(1, 1, 1, 1);
                    } else {
                        this.reachyMiniManager.checkConnection().then((isConnected: boolean) => {
                            if (isConnected) {
                                this.textConnectionStatus.text = "Connected";
                                this.textConnectionStatus.textFill.color = new vec4(0, 1, 0, 1);
                            } else {
                                this.textConnectionStatus.text = "Not connected";
                                this.textConnectionStatus.textFill.color = new vec4(1, 0, 0, 1);
                            }
                        });
                    }
                }

                break;
        }
    }


    // ------------------------------------------------------------
    // Helper functions
    // ------------------------------------------------------------
    private animateSceneObjectState(sceneObject: SceneObject, state: boolean, duration: number = 0.5): Promise<void> {
        // Enable before animating in
        if (state) {
            sceneObject.enabled = true;
        }

        // Get the current scale to handle interruptions gracefully
        const currentScale = sceneObject.getTransform().getLocalScale();
        const targetScale = state ? new vec3(1, 1, 1) : new vec3(0.01, 0.01, 0.01);

        // Use current scale as starting point to handle mid-animation interruptions
        const startScale = new vec3(currentScale.x, currentScale.y, currentScale.z);

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
                    // Ensure final scale is exactly the target
                    sceneObject.getTransform().setLocalScale(targetScale);
                    if (!state) {
                        sceneObject.enabled = false;
                    }
                    resolve();
                },
            });
        });
    }
}
