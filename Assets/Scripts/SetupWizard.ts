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
    private stepOperationId : number = 0;
    private simulationMode : boolean = false;

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
    private textButtonNext : Text | null = null;
    @input
    private buttonPrevious : RectangleButton | null = null;
    @input
    private textButtonPrevious : Text | null = null;
    @input
    private textInputField : TextInputField | null = null;

    private steps : string[] = [
        "Launch Reachy Mini App",
        "Connect to Desktop App",
        "Position Reachy Mini",
        ""
    ];

    private stepDescriptions : string[] = [
        " \n \n In the Reachy Mini Desktop application, start the app: \n 'reachy_mini_spectacles' ",
        " \n Enter the IP address of your PC",
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
                    if (this.currentStep === 0) {
                        this.simulationMode = true;
                        if (this.reachyMiniManager) {
                            this.reachyMiniManager.setSimulationMode(true);
                        }
                        this.setStep(2);
                    }
                    else if (this.currentStep === 2 && this.simulationMode) {
                        this.simulationMode = false;
                        if (this.reachyMiniManager) {
                            this.reachyMiniManager.setSimulationMode(false);
                        }
                        this.setStep(0);
                    }
                    else {
                        this.setStep(this.currentStep - 1);
                    }
                });
            }
            if (this.buttonRestart) {
                this.buttonRestart.onTriggerUp.add((args: any) => {
                    this.startSetupWizard();
                });
            }

            // Handle IP typing: update IP address in daemon interface and check connection
            if (this.textInputField && this.reachyMiniManager.hardwareInterface) {
                this.textInputField.onReturnKeyPressed.add((value: string) => {
                    this.updateConnectionStatus();
                });
                this.textInputField.onKeyboardStateChanged.add((isOpen: boolean) => {
                    if (!isOpen) {
                        this.updateConnectionStatus();
                    }
                });
            }

            this.startSetupWizard();
        });
    }

    public startSetupWizard() {
        this.simulationMode = false;
        this.animateSceneObjectState(this.uiSetupContainer, true);
        this.setStep(0);
        if (this.reachyMiniManager) {
            this.reachyMiniManager.setIsActive(false);
            this.reachyMiniManager.setControlMode(0);
            this.reachyMiniManager.setSimulationMode(false);
        }
    }

    private async setStep(step : number) {
        // Cancel any previous async operations by incrementing the operation ID
        this.stepOperationId++;
        const currentOperationId = this.stepOperationId;

        // Update text fields
        this.currentStep = step;
        if (this.textStepIndicator && step < this.steps.length) {
            this.textStepIndicator.text = this.steps[step];
        }
        if (this.textStepDescription && step < this.stepDescriptions.length) {
            this.textStepDescription.text = this.stepDescriptions[step];
        }

        // Step specific actions
        switch (step) {

            // Step 1: Start Desktop application or show simulation mode
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

                if (this.textButtonPrevious && this.textButtonNext) {
                    this.textButtonPrevious.text = "I have no Reachy Mini";
                    this.textButtonNext.text = "Next";
                }
                
                if (this.uiManager) {
                    this.uiManager.setUIState(0);
                }
                break;

            // Step 2: Connect to Desktop
            case 1:
                if (this.reachyMiniManager) {
                    this.reachyMiniManager.setPositioningEnabled(false);
                }

                if (this.textButtonPrevious && this.textButtonNext) {
                    this.textButtonPrevious.text = "Back";
                    this.textButtonNext.text = "Next";
                }
                
                // Load saved IP and populate text field
                const savedIp = this.persistenceManager ? this.persistenceManager.loadIp() : null;
                if (savedIp && this.reachyMiniManager && this.reachyMiniManager.hardwareInterface) {
                    this.reachyMiniManager.hardwareInterface.baseUrl = savedIp;
                }
                
                if (this.textInputField && this.reachyMiniManager && this.reachyMiniManager.hardwareInterface && this.textStepStatus) {
                    this.textInputField.enabled = true;
                    this.textInputField.initialize();
                    // Use saved IP if available, otherwise use current baseUrl
                    this.textInputField.text = savedIp || this.reachyMiniManager.hardwareInterface.baseUrl;
                    this.updateConnectionStatus();
                }
                if (this.textStepStatus) {
                    this.textStepStatus.text = "Connecting...";
                    this.textStepStatus.textFill.color = new vec4(1, 1, 1, 1);
                    this.textStepStatus.sceneObject.enabled = true;
                }
                break;

            // Step 3: Position Reachy Mini
            case 2:
                if (this.textInputField && this.buttonNext && this.textButtonNext) {
                    this.buttonNext.enabled = false;
                    this.textButtonNext.text = "";
                    this.textInputField.enabled = false;
                }
                if (this.textStepStatus) {
                    this.textStepStatus.sceneObject.enabled = true;
                    this.textStepStatus.textFill.color = new vec4(1, 1, 0, 1);
                    this.textStepStatus.text = "Searching for saved position...";
                }

                if (this.textButtonPrevious) {
                    this.textButtonPrevious.text = "Back";
                }

                if (this.reachyMiniManager && this.uiSetupContainer) {
                    const anchorLoaded = await this.tryLoadAnchor();

                    // Check if operation was cancelled (step changed)
                    if (currentOperationId !== this.stepOperationId) {
                        return;
                    }

                    if (anchorLoaded) {
                        if (this.textStepStatus) {
                            this.textStepStatus.text = "Saved position loaded";
                            this.textStepStatus.textFill.color = new vec4(0, 1, 0, 1);
                        }
                    } else {
                        const uiPosition = this.uiSetupContainer.getTransform().getWorldPosition();
                        const defaultPosition = new vec3(uiPosition.x, uiPosition.y - 35, uiPosition.z);
                        this.reachyMiniManager.setRootPosition(defaultPosition);
                        
                        if (this.textStepStatus) {
                            this.textStepStatus.text = "No saved position found";
                            this.textStepStatus.textFill.color = new vec4(1, 1, 0, 1);
                        }
                    }

                    if (this.buttonNext && this.textButtonNext) {
                        this.textButtonNext.text = "Complete";
                        this.buttonNext.enabled = true;
                    }
                    if (this.reachyMiniManager.isSimulationMode) {
                        this.reachyMiniManager.showReachyMiniMesh(true);
                    }
                    this.reachyMiniManager.setPositioningEnabled(true);
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
        if (this.reachyMiniManager && this.reachyMiniManager.hardwareInterface) {
            const operationIdAtStart = this.stepOperationId;
            
            this.textStepStatus.text = "Checking connection...";
            this.textStepStatus.textFill.color = new vec4(1, 1, 1, 1);

            this.reachyMiniManager.hardwareInterface.baseUrl = this.textInputField.text;
            this.reachyMiniManager.hardwareInterface.checkConnection().then((isConnected: boolean) => {
                // Check if step changed during async operation
                if (operationIdAtStart !== this.stepOperationId) {
                    return;
                }
                
                if (isConnected) {
                    this.textStepStatus.text = "Connected";
                    this.textStepStatus.textFill.color = new vec4(0, 1, 0, 1);
                    // Save IP on successful connection
                    if (this.persistenceManager) {
                        this.persistenceManager.saveIp(this.textInputField.text);
                    }
                } else {
                    this.textStepStatus.text = "Not connected";
                    this.textStepStatus.textFill.color = new vec4(1, 0, 0, 1);
                }
            });
        }
    }

    private async tryLoadAnchor(): Promise<boolean> {
        if (!this.persistenceManager || !this.reachyMiniManager) {
            return false;
        }

        const position = await this.persistenceManager.loadAnchorPosition();
        
        if (position) {
            this.reachyMiniManager.setRootPosition(position);
            return true;
        }
        return false;
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
