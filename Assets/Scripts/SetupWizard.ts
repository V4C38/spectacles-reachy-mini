import { RectangleButton } from "SpectaclesUIKit.lspkg/Scripts/Components/Button/RectangleButton";
import { TextInputField } from "SpectaclesUIKit.lspkg/Scripts/Components/TextInputField/TextInputField";
import animate from "SpectaclesInteractionKit.lspkg/Utils/animate";


import { ReachyMiniManager } from "./ReachyMiniManager";
import { UIManager } from "./UIManager";

@component
export class SetupWizard extends BaseScriptComponent {

    @input
    private reachyMiniManager : ReachyMiniManager | null = null;
    @input
    private uiManager : UIManager | null = null;
    @input
    private buttonRestart : RectangleButton | null = null;

    private currentStep : number = 0;

    @input
    private uiSetupContainer : SceneObject | null = null;

    @input
    private textStepIndicator : Text | null = null;
    @input
    private textStepDescription : Text | null = null;
    @input
    private textStepStatus : Text | null = null;

    @input
    private buttonNext : RectangleButton | null = null;
    @input
    private buttonPrevious : RectangleButton | null = null;
    @input
    private textInputField : TextInputField | null = null;

    private steps : string[] = [
        "Let's setup Reachy Mini!",
        "Step 1: Start Desktop application",
        "Step 2: Connect to Desktop",
        "Step 3: Position Reachy Mini",
        "Step 4: Complete the setup",
        ""
    ];

    private stepDescriptions : string[] = [
        " \n \n Follow the instructions in the setup wizard.",
        " \n \n Connect Reachy Mini to your PC and start  \n the Desktop application: 'reachy_mini_spectacles'",
        "Enter the IP address of the PC",
        " \n \n Position Reachy Mini in the desired location  \n You can adjust this later in the settings.",
        " \n \n You are all set! Reachy Mini is ready to use.",
        ""
    ];


    onAwake() {
        this.setStep(0);

        // Defer button subscription to OnStartEvent
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
                    this.setStep(0);
                    if (this.reachyMiniManager) {
                        this.reachyMiniManager.setIsActive(false);
                        this.reachyMiniManager.setControlMode(0);
                    }
                });
            }

            // Handle IP typing: update IP address in daemon interface and check connection
            if (this.textInputField && this.reachyMiniManager.daemonInterface) {
                this.textInputField.onReturnKeyPressed.add((value: string) => {
                    this.updateConnectionStatus();
                });
                this.textInputField.onKeyboardStateChanged.add((isOpen: boolean) => {
                    if (!isOpen) {
                        this.updateConnectionStatus();
                    }
                });
            }
        });
    }

    private setStep(step : number) {

        // Update text fields
        this.currentStep = step;
        if (this.textStepIndicator && step < this.steps.length) {
            this.textStepIndicator.text = this.steps[step];
        }
        if (this.textStepDescription && step < this.stepDescriptions.length) {
            this.textStepDescription.text = this.stepDescriptions[step];
        }

        // Show / Hide text input field
        if (this.textInputField) {
            this.textInputField.enabled = step === 2;
        }

        // Show / Hide text step status
        if (this.textStepStatus) {
            this.textStepStatus.text = "Status: Not connected";
            this.textStepStatus.sceneObject.enabled = this.currentStep === 2 || this.currentStep === 4;
        }

        // Show / Hide previous button
        if (this.buttonPrevious) {
            this.buttonPrevious.sceneObject.enabled = step > 1;
        }

        // Step specific actions
        switch (step) {

            // Start
            case 0:
                this.animateSceneObjectState(this.uiSetupContainer, true);
                if (this.uiManager) {
                    this.uiManager.setUIState(0);
                }
                break;

            // Step 1: Start Desktop application
            case 1:
                break;

            // Step 2: Connect to Desktop
            case 2:
                if (this.reachyMiniManager) {
                    this.reachyMiniManager.setPositioningEnabled(false);
                }
                if (this.textInputField && this.reachyMiniManager && this.reachyMiniManager.daemonInterface && this.textStepStatus) {
                    this.textInputField.enabled = true;
                    this.textInputField.initialize();
                    this.textInputField.text = this.reachyMiniManager.daemonInterface.baseUrl;
                    this.updateConnectionStatus();
                }
                break;

            // Step 3: Position Reachy Mini
            case 3:
                if (this.reachyMiniManager && this.uiSetupContainer) {
                    // Position Reachy Mini Hologram below the UI container
                    const uiPosition = this.uiSetupContainer.getTransform().getWorldPosition();
                    const targetPosition = new vec3(uiPosition.x, uiPosition.y - 20, uiPosition.z);
                    this.reachyMiniManager.setRootPosition(targetPosition);
                    this.reachyMiniManager.setPositioningEnabled(true);

                }
                break;

            // Step 4: Complete the setup
            case 4:
                if (this.reachyMiniManager && this.reachyMiniManager.daemonInterface) {
                    this.updateConnectionStatus();
                    this.reachyMiniManager.setPositioningEnabled(false);
                }
                break;

            // End
            case 5:
                this.animateSceneObjectState(this.uiSetupContainer, false);
                if (this.uiManager) {
                    this.uiManager.setUIState(2);
                    this.uiManager.setMode(2);
                }
                break;
        }
    }

    // ------------------------------------------------------------
    // Helper functions
    // ------------------------------------------------------------
    private updateConnectionStatus() {
        if (this.reachyMiniManager && this.reachyMiniManager.daemonInterface) {
            this.textStepStatus.text = "Status: Checking connection...";
            this.textStepStatus.textFill.color = new vec4(1, 1, 1, 1);

            this.reachyMiniManager.daemonInterface.baseUrl = this.textInputField.text;
            this.reachyMiniManager.daemonInterface.checkConnection().then((isConnected: boolean) => {
                if (isConnected) {
                    this.textStepStatus.text = "Status: Connected";
                    this.textStepStatus.textFill.color = new vec4(0, 1, 0, 1);
                } else {
                    this.textStepStatus.text = "Status: Not connected";
                    this.textStepStatus.textFill.color = new vec4(1, 0, 0, 1);
                }
            });
        }
    }

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
