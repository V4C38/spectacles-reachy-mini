import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import { RectangleButton } from "SpectaclesUIKit.lspkg/Scripts/Components/Button/RectangleButton";
import { TextInputField } from "SpectaclesUIKit.lspkg/Scripts/Components/TextInputField/TextInputField";
import animate from "SpectaclesInteractionKit.lspkg/Utils/animate";

import { IpRelayClient } from "./IpRelayClient";
import { ReachyMiniManager } from "./ReachyMiniManager";
import { UIManager } from "./UIManager";

type ConnectionMethod = "pin" | "ip";

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

    @input
    private buttonConnectionMethod: RectangleButton | null = null;
    @input
    private textButtonConnectionMethod: Text | null = null;
    @input
    private internetModule: InternetModule | null = null;

    private connectionMethod: ConnectionMethod = "pin";
    private ipRelayClient: IpRelayClient | null = null;
    private connectionToggleRoot: SceneObject | null = null;

    private steps: string[] = [
        "Launch Reachy Mini App",
        "Connect to Reachy Mini App",
        "Position Reachy Mini",
        ""
    ];

    private stepDescriptions: string[] = [
        " \n \n In the Reachy Mini Desktop application, start the app: \n \n 😎 spectacles_reachy_mini ",
        " \n Enter the PIN shown by the Reachy Mini app",
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

            const relayModule = this.internetModule
                || (this.reachyMiniManager && this.reachyMiniManager.robotDriver
                    ? this.reachyMiniManager.robotDriver.getInternetModule()
                    : null);
            if (relayModule) {
                this.ipRelayClient = new IpRelayClient(relayModule);
            }
            this.ensureConnectionToggle();

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

    private setStep(step: number) {
        this.stepOperationId++;

        this.currentStep = step;
        this.setConnectionToggleEnabled(step === 1);
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

                if (this.textButtonPrevious && this.textButtonNext && this.buttonNext) {
                    this.textButtonPrevious.text = "I have no Reachy Mini";
                    this.textButtonNext.text = "Next";
                    this.buttonNext.enabled = true;
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

                this.connectionMethod = "pin";

                if (this.textInputField) {
                    this.textInputField.enabled = true;
                    this.textInputField.initialize();
                    this.textInputField.text = "";
                }
                if (this.textStepStatus) {
                    this.textStepStatus.textFill.color = new vec4(1, 1, 1, 1);
                    this.textStepStatus.sceneObject.enabled = true;
                    this.textStepStatus.text = "Enter a 6-digit PIN";
                }
                this.applyConnectionMethod(false);
                break;

            // Step 3: Position Reachy Mini
            case 2:
                if (this.textInputField && this.buttonNext && this.textButtonNext) {
                    this.buttonNext.enabled = false;
                    this.textButtonNext.text = "";
                    this.textInputField.enabled = false;
                }
                if (this.textButtonPrevious) {
                    this.textButtonPrevious.text = "Back";
                }

                if (this.reachyMiniManager && this.uiSetupContainer) {
                    const uiPosition = this.uiSetupContainer.getTransform().getWorldPosition();
                    const defaultPosition = new vec3(uiPosition.x, uiPosition.y - 35, uiPosition.z);
                    this.reachyMiniManager.setRootPosition(defaultPosition);

                    if (this.textStepStatus) {
                        this.textStepStatus.sceneObject.enabled = true;
                        this.textStepStatus.text = "Position Reachy Mini";
                        this.textStepStatus.textFill.color = new vec4(1, 1, 1, 1);
                    }

                    if (this.buttonNext && this.textButtonNext) {
                        this.textButtonNext.text = "Complete";
                        this.buttonNext.enabled = true;
                    }
                    if (this.reachyMiniManager.isSimulationMode) {
                        this.reachyMiniManager.showReachyMiniMesh(true);
                    }
                    this.reachyMiniManager.setPositioningEnabled(true);
                    this.reachyMiniManager.resetPosition();
                }
                break;

            // End
            case 3:
                if (this.reachyMiniManager) {
                    this.reachyMiniManager.setPositioningEnabled(false);
                }
                this.animateSceneObjectState(this.uiSetupContainer, false);
                if (this.uiManager) {
                    this.uiManager.setMode(1);
                    this.uiManager.setUIState(1);
                }
                break;
        }
    }

    // ------------------------------------------------------------
    // Autoconnect
    // ------------------------------------------------------------
    private ensureConnectionToggle() {
        if (this.buttonConnectionMethod) {
            this.buttonConnectionMethod.onTriggerUp.add(() => this.onConnectionToggle());
            return;
        }
        if (!this.uiSetupContainer) return;

        const root = global.scene.createSceneObject("Button_ConnectionMethod");
        root.setParent(this.uiSetupContainer);
        const textObject = global.scene.createSceneObject("ConnectionMethodText");
        textObject.setParent(root);
        const text = textObject.createComponent("Component.Text") as Text;
        text.size = 32;
        text.text = "Mode: PIN";
        this.textButtonConnectionMethod = text;

        const collider = root.createComponent("Physics.ColliderComponent") as ColliderComponent;
        const box = Shape.createBoxShape();
        box.size = new vec3(13, 3, 1);
        collider.shape = box;
        const interactable = root.createComponent(Interactable.getTypeName()) as Interactable;
        interactable.onTriggerEnd.add(() => this.onConnectionToggle());
        this.connectionToggleRoot = root;
    }

    private setConnectionToggleEnabled(on: boolean) {
        const buttonObject = this.buttonConnectionMethod
            ? this.buttonConnectionMethod.sceneObject
            : null;
        if (this.buttonConnectionMethod && buttonObject) {
            this.buttonConnectionMethod.enabled = on;
            buttonObject.enabled = on;
        }
        if (this.textButtonConnectionMethod) {
            const labelObject = this.textButtonConnectionMethod.sceneObject;
            if (!buttonObject || labelObject.getParent() !== buttonObject) {
                labelObject.enabled = on;
            }
        }
        if (this.connectionToggleRoot) {
            this.connectionToggleRoot.enabled = on;
        }
    }

    private onConnectionToggle() {
        if (this.currentStep !== 1) return;
        this.stepOperationId++;
        this.connectionMethod = this.connectionMethod === "pin" ? "ip" : "pin";
        if (this.textStepStatus) {
            this.textStepStatus.text = "";
        }
        this.applyConnectionMethod(true);
        if (this.connectionMethod === "ip") {
            this.startAutoconnect();
        }
    }

    private applyConnectionMethod(clearedByToggle: boolean) {
        if (this.textInputField) {
            this.textInputField.placeholderText = this.connectionMethod === "pin"
                ? "6 Digit PIN code"
                : "IP Address";
        }
        if (this.connectionMethod === "pin") {
            this.stepDescriptions[1] = " \n Enter the PIN shown by the Reachy Mini app";
            if (this.textButtonConnectionMethod) {
                this.textButtonConnectionMethod.text = "Mode: PIN";
            }
            if (clearedByToggle && this.textInputField) {
                this.textInputField.text = "";
            }
        } else {
            this.stepDescriptions[1] = " \n Enter the IP address of your PC";
            if (this.textButtonConnectionMethod) {
                this.textButtonConnectionMethod.text = "Mode: IP";
            }
            if (this.textInputField && this.reachyMiniManager) {
                const savedIp = this.reachyMiniManager.loadIp();
                this.textInputField.text = savedIp || this.reachyMiniManager.getBaseUrl();
            }
        }
        if (this.textStepDescription && this.currentStep === 1) {
            this.textStepDescription.text = this.stepDescriptions[1];
        }
    }

    private startAutoconnect() {
        this.stepOperationId++;
        const opId = this.stepOperationId;

        if (!this.reachyMiniManager || !this.textInputField) return;

        if (this.connectionMethod === "pin") {
            this.resolvePin(opId);
            return;
        }
        this.connectHost(opId, this.textInputField.text);
    }

    private resolvePin(opId: number) {
        const pin = (this.textInputField.text || "").replace(/\s/g, "");
        if (!/^\d{6}$/.test(pin) || !this.ipRelayClient) {
            if (this.textStepStatus) {
                this.textStepStatus.text = this.ipRelayClient ? "Enter a 6-digit PIN" : "PIN unavailable";
                this.textStepStatus.textFill.color = new vec4(1, 1, 1, 1);
            }
            return;
        }

        if (this.textStepStatus) {
            this.textStepStatus.text = "Resolving PIN...";
            this.textStepStatus.textFill.color = new vec4(1, 1, 1, 1);
        }

        this.ipRelayClient.resolve(pin).then((found) => {
            if (opId !== this.stepOperationId) return;
            if (!found) {
                if (this.textStepStatus) {
                    this.textStepStatus.text = "PIN not found";
                    this.textStepStatus.textFill.color = new vec4(1, 0, 0, 1);
                }
                this.schedulePinRetry(opId);
                return;
            }
            this.connectHost(opId, found.ip);
        });
    }

    private connectHost(opId: number, host: string) {
        if (!this.reachyMiniManager) return;
        this.reachyMiniManager.setBaseUrl(host);

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
                this.reachyMiniManager.saveIp(host);
            } else {
                if (this.textStepStatus) {
                    this.textStepStatus.text = "Not connected — retrying...";
                    this.textStepStatus.textFill.color = new vec4(1, 0, 0, 1);
                }
                this.scheduleHostRetry(opId, host);
            }
        });
    }

    private schedulePinRetry(opId: number) {
        const retryEvent = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
        retryEvent.bind(() => {
            if (opId !== this.stepOperationId) return;
            this.resolvePin(opId);
        });
        retryEvent.reset(2.0);
    }

    private scheduleHostRetry(opId: number, host: string) {
        const retryEvent = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
        retryEvent.bind(() => {
            if (opId !== this.stepOperationId) return;
            this.connectHost(opId, host);
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
