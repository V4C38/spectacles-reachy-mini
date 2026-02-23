import { RectangleButton } from "SpectaclesUIKit.lspkg/Scripts/Components/Button/RectangleButton";
import { TextInputField } from "SpectaclesUIKit.lspkg/Scripts/Components/TextInputField/TextInputField";
import animate from "SpectaclesInteractionKit.lspkg/Utils/animate";

import { ReachyMiniManager } from "./ReachyMiniManager";
import { UIManager } from "./UIManager";

@component
export class SetupWizard extends BaseScriptComponent {

    @input
    private reachyMiniManager: ReachyMiniManager | null = null;
    @input
    private uiManager: UIManager | null = null;
    @input
    private buttonRestart: RectangleButton | null = null;

    private currentStep: number = 0;
    private stepOperationId: number = 0;
    private simulationMode: boolean = false;

    @input
    private uiSetupContainer: SceneObject | null = null;

    @input
    private textStepIndicator: Text | null = null;
    @input
    private textStepDescription: Text | null = null;
    @input
    private textStepStatus: Text | null = null;

    @input
    private buttonNext: RectangleButton | null = null;
    @input
    private textButtonNext: Text | null = null;
    @input
    private buttonPrevious: RectangleButton | null = null;
    @input
    private textButtonPrevious: Text | null = null;
    @input
    private textInputField: TextInputField | null = null;

    private steps: string[] = [
        "Reachy Mini Simulator",
        "Position Reachy Mini",
        ""
    ];

    private stepDescriptions: string[] = [
        " \n \n Welcome to the simulator-only version! \n \n \n The full version can be found on github.com/V4C38",
        " \n \n Position Reachy Mini in the desired location  \n You can adjust this later in the settings.",
        ""
    ];


    onAwake() {
        // Defer button subscription and saved state check to OnStartEvent
        this.createEvent("OnStartEvent").bind(() => {


            if (this.buttonNext && this.buttonPrevious) {

                this.buttonNext.onTriggerUp.add((args: any) => {
                    this.setStep(this.currentStep + 1);
                });
                this.buttonPrevious.onTriggerUp.add((args: any) => {
                    this.setStep(this.currentStep - 1);
                });
            }
            if (this.buttonRestart) {
                this.buttonRestart.onTriggerUp.add((args: any) => {
                    this.startSetupWizard();
                });
            }

            if (this.textInputField && this.reachyMiniManager) {
                this.textInputField.onReturnKeyPressed.add(() => {
                    this.startAutoconnect();
                });
                this.textInputField.onKeyboardStateChanged.add((isOpen: boolean) => {
                    if (!isOpen) {
                        this.startAutoconnect();
                    }
                });
            }

            this.startSetupWizard();
        });
    }

    public startSetupWizard() {
        this.simulationMode = true;
        this.animateSceneObjectState(this.uiSetupContainer, true);
        this.setStep(0);
        if (this.reachyMiniManager) {
            this.reachyMiniManager.setIsActive(false);
            this.reachyMiniManager.setControlMode(0);
            this.reachyMiniManager.setSimulationMode(true);
        }
    }

    private setStep(step: number) {
        this.stepOperationId++;

        this.currentStep = step;
        if (this.textStepIndicator && step < this.steps.length) {
            this.textStepIndicator.text = this.steps[step];
        }
        if (this.textStepDescription && step < this.stepDescriptions.length) {
            this.textStepDescription.text = this.stepDescriptions[step];
        }

        switch (step) {

            // Step 0: Welcome
            case 0:
                if (this.reachyMiniManager) {
                    this.reachyMiniManager.setIsActive(false);
                    this.reachyMiniManager.setPositioningEnabled(false);
                    this.reachyMiniManager.showReachyMiniMesh(false);
                }
                if (this.textInputField && this.textStepStatus) {
                    this.textInputField.enabled = false;
                    this.textStepStatus.sceneObject.enabled = false;
                }

                if (this.buttonPrevious && this.textButtonPrevious) {
                    this.buttonPrevious.enabled = false;
                    this.textButtonPrevious.text = "";
                }
                if (this.buttonNext && this.textButtonNext) {
                    this.textButtonNext.text = "Next";
                    this.buttonNext.enabled = true;
                }

                if (this.uiManager) {
                    this.uiManager.setUIState(0);
                }
                break;

            // Step 1: Position Reachy Mini
            case 1:
                if (this.textInputField) {
                    this.textInputField.enabled = false;
                }

                if (this.buttonPrevious && this.textButtonPrevious) {
                    this.buttonPrevious.enabled = true;
                    this.textButtonPrevious.text = "Back";
                }

                if (this.reachyMiniManager && this.uiSetupContainer) {
                    const uiPosition = this.uiSetupContainer.getTransform().getWorldPosition();
                    const defaultPosition = new vec3(uiPosition.x, uiPosition.y - 35, uiPosition.z);
                    this.reachyMiniManager.setRootPosition(defaultPosition);

                    if (this.textStepStatus) {
                        this.textStepStatus.sceneObject.enabled = false;
                    }

                    if (this.buttonNext && this.textButtonNext) {
                        this.textButtonNext.text = "Complete";
                        this.buttonNext.enabled = true;
                    }
                    this.reachyMiniManager.showReachyMiniMesh(true);
                    this.reachyMiniManager.setPositioningEnabled(true);
                }
                break;

            // Step 2: End
            case 2:
                if (this.reachyMiniManager) {
                    this.reachyMiniManager.setPositioningEnabled(false);
                }
                this.animateSceneObjectState(this.uiSetupContainer, false);
                if (this.uiManager) {
                    this.uiManager.setUIState(2);
                    this.uiManager.setMode(2);
                }
                break;
        }
    }

    // ------------------------------------------------------------
    // Autoconnect
    // ------------------------------------------------------------
    private startAutoconnect() {
        this.stepOperationId++;
        const opId = this.stepOperationId;

        if (!this.reachyMiniManager || !this.textInputField) return;

        this.reachyMiniManager.setBaseUrl(this.textInputField.text);

        if (this.textStepStatus) {
            this.textStepStatus.text = "Connecting...";
            this.textStepStatus.textFill.color = new vec4(1, 1, 1, 1);
        }

        this.reachyMiniManager.checkConnection().then((isConnected: boolean) => {
            if (opId !== this.stepOperationId) return;

            if (isConnected) {
                if (this.textStepStatus) {
                    this.textStepStatus.text = "Connected";
                    this.textStepStatus.textFill.color = new vec4(0, 1, 0, 1);
                }
                this.reachyMiniManager.saveIp(this.textInputField.text);
            } else {
                if (this.textStepStatus) {
                    this.textStepStatus.text = "Not connected — retrying...";
                    this.textStepStatus.textFill.color = new vec4(1, 0, 0, 1);
                }
                this.scheduleAutoconnectRetry(opId);
            }
        });
    }

    private scheduleAutoconnectRetry(opId: number) {
        const retryEvent = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
        retryEvent.bind(() => {
            if (opId !== this.stepOperationId) return;
            this.reachyMiniManager.setBaseUrl(this.textInputField.text);

            if (this.textStepStatus) {
                this.textStepStatus.text = "Connecting...";
                this.textStepStatus.textFill.color = new vec4(1, 1, 1, 1);
            }

            this.reachyMiniManager.checkConnection().then((isConnected: boolean) => {
                if (opId !== this.stepOperationId) return;

                if (isConnected) {
                    if (this.textStepStatus) {
                        this.textStepStatus.text = "Connected";
                        this.textStepStatus.textFill.color = new vec4(0, 1, 0, 1);
                    }
                    this.reachyMiniManager.saveIp(this.textInputField.text);
                } else {
                    if (this.textStepStatus) {
                        this.textStepStatus.text = "Not connected — retrying...";
                        this.textStepStatus.textFill.color = new vec4(1, 0, 0, 1);
                    }
                    this.scheduleAutoconnectRetry(opId);
                }
            });
        });
        retryEvent.reset(2.0);
    }

    private animateSceneObjectState(sceneObject: SceneObject, state: boolean, duration: number = 0.5): Promise<void> {
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
