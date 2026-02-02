import { RectangleButton } from "SpectaclesUIKit.lspkg/Scripts/Components/Button/RectangleButton";
import { TextInputField } from "SpectaclesUIKit.lspkg/Scripts/Components/TextInputField/TextInputField";
import animate from "SpectaclesInteractionKit.lspkg/Utils/animate";

import { ReachyMiniManager } from "./ReachyMiniManager";
import { UIManager } from "./UIManager";
import { PersistenceManager } from "./PersistenceManager";

@component
export class SetupWizard extends BaseScriptComponent {

    @input
    private reachyMiniManager : ReachyMiniManager | null = null;
    @input
    private uiManager : UIManager | null = null;
    @input
    private persistenceManager : PersistenceManager | null = null;
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
        "1: Start Desktop application",
        "2: Connect to Desktop",
        "3: Position Reachy Mini",
        ""
    ];

    private stepDescriptions : string[] = [
        " \n \n Connect Reachy Mini to your PC and start  \n the Desktop application: 'reachy_mini_spectacles'",
        "Enter the IP address of the PC",
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

            this.setStep(0);
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

        // Show / Hide previous button
        if (this.buttonPrevious) {
            this.buttonPrevious.sceneObject.enabled = step > 0;
        }

        // Step specific actions
        switch (step) {

            // Step 1: Start Desktop application
            case 0:
                if (this.reachyMiniManager) {
                    this.reachyMiniManager.setIsActive(false);
                }
                if (this.textInputField && this.textStepStatus) {
                    this.textInputField.enabled = false;
                    this.textStepStatus.sceneObject.enabled = false;
                }
                
                this.animateSceneObjectState(this.uiSetupContainer, true);
                if (this.uiManager) {
                    this.uiManager.setUIState(0);
                }
                break;

            // Step 2: Connect to Desktop
            case 1:
                if (this.reachyMiniManager) {
                    this.reachyMiniManager.setPositioningEnabled(false);
                }
                
                // Load saved IP and populate text field
                const savedIp = this.persistenceManager ? this.persistenceManager.loadIp() : null;
                if (savedIp && this.reachyMiniManager && this.reachyMiniManager.daemonInterface) {
                    this.reachyMiniManager.daemonInterface.baseUrl = savedIp;
                    print(`SetupWizard: Restored IP: ${savedIp}`);
                }
                
                if (this.textInputField && this.reachyMiniManager && this.reachyMiniManager.daemonInterface && this.textStepStatus) {
                    this.textInputField.enabled = true;
                    this.textInputField.initialize();
                    // Use saved IP if available, otherwise use current baseUrl
                    this.textInputField.text = savedIp || this.reachyMiniManager.daemonInterface.baseUrl;
                    this.updateConnectionStatus();
                }
                if (this.textStepStatus) {
                    this.textStepStatus.text = "Status: Connecting...";
                    this.textStepStatus.textFill.color = new vec4(1, 1, 1, 1);
                    this.textStepStatus.sceneObject.enabled = true;
                }
                break;

            // Step 3: Position Reachy Mini
            case 2:
                if (this.textInputField && this.textStepStatus) {
                    this.textInputField.enabled = false;
                    this.textStepStatus.sceneObject.enabled = false;
                }
                if (this.reachyMiniManager && this.uiSetupContainer && this.persistenceManager) {
                    // Initialize anchors - callback sets position if anchor found
                    this.persistenceManager.onPositionRestored = (position, rotation) => {
                        this.reachyMiniManager.setRootPosition(position, rotation);
                        print("SetupWizard: Anchor found, position restored");
                    };
                    this.persistenceManager.initializeAnchors();
                    
                    // Set default position below UI (will be overridden if anchor found)
                    const uiPosition = this.uiSetupContainer.getTransform().getWorldPosition();
                    const defaultPosition = new vec3(uiPosition.x, uiPosition.y - 20, uiPosition.z);
                    this.reachyMiniManager.setRootPosition(defaultPosition);
                    
                    // Enable positioning with save-on-move
                    this.reachyMiniManager.setPositioningEnabled(true, true);
                }
                break;

            // End
            case 3:
                if (this.reachyMiniManager) {
                    this.reachyMiniManager.setPositioningEnabled(false);
                }
                this.animateSceneObjectState(this.uiSetupContainer, false);
                if (this.uiManager) {
                    this.uiManager.setUIState(2);
                    this.uiManager.setMode(1);
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
                    // Save IP on successful connection
                    if (this.persistenceManager) {
                        this.persistenceManager.saveIp(this.textInputField.text);
                    }
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
