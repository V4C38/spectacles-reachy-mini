import { Switch } from "SpectaclesUIKit.lspkg/Scripts/Components/Switch/Switch";

import { ToolDefinition, LLMService } from "../LLMService";
import { AssistantMode } from "../AssistantMode";
import { AssistantState } from "../AssistantMode";
import { HardwareAdapter } from "../../RobotDriver/HardwareAdapter";
import { MLObjectDetector } from "../../Utils/MLObjectDetector";
import { RobotDriver } from "../../RobotDriver/RobotDriver";
import { getObjectLinkRenderer } from "../../Utils/ObjectLinkRenderer";

import { createScanObjectsTool } from "./ScanObjectsTool";
import { createLookAtTool } from "./LookAtTool";
import { createGetStateTool } from "./GetStateTool";
import { createPlayAnimationTool, createGetAvailableAnimationsTool } from "./PlayAnimationTool";
import { createDrawLineTool } from "./DrawLineTool";
import { createTakePictureRobotViewTool } from "./TakePictureRobotViewTool";

/**
 * Component that provides LLM tools for the AssistantMode.
 * Add this component to a scene object and configure the required inputs.
 * Tools will only be registered if their dependencies are available.
 */
@component
export class ToolFactory extends BaseScriptComponent {

    // --- Required References ---
    @input
    public assistantMode: AssistantMode | null = null;
    @input
    public mlDetector: MLObjectDetector | null = null;
    @input
    public robotDriver: RobotDriver | null = null;
    @input
    public objectMarkerPrefab: ObjectPrefab | null = null;
    @input
    public lineRendererPrefab: ObjectPrefab | null = null;
    @input
    private hardwareAdapter: HardwareAdapter | null = null;

    @input
    private switchObjectDetectionTool: Switch | null = null;

    // --- State ---
    private scanIsScanning: (() => boolean) | null = null;

    @input
    private textDebugInfo: Text | null = null;

    private logDebug(message: string): void {
        if (this.textDebugInfo) {
            this.textDebugInfo.text = message;
        }
    }

    /** Round coordinate to two decimal places (1 unit = 1 cm). Use in tool I/O for consistent formatting. */
    private roundCoord(v: number): number {
        return Math.round(v * 100) / 100;
    }

    /**
     * Registers all available tools with the provided LLM service.
     * Only tools whose dependencies are available will be registered.
     */
    public registerTools(llmService: LLMService): void {
        if (!llmService) {
            print("ToolFactory: LLMService not provided, skipping tool registration");
            return;
        }

        llmService.clearTools();
        let registeredCount = 0;

        // Register scan_objects tool if dependencies are available
        if (this.mlDetector && this.objectMarkerPrefab && this.assistantMode) {

            if (this.switchObjectDetectionTool && this.switchObjectDetectionTool.isOn) {
                const scanResult = createScanObjectsTool({
                    assistantMode: this.assistantMode,
                    mlDetector: this.mlDetector,
                    objectMarkerPrefab: this.objectMarkerPrefab,
                    roundCoord: (v) => this.roundCoord(v),
                    logDebug: (msg) => this.logDebug(msg),
                });
                llmService.registerTool(scanResult.tool);
                this.scanIsScanning = scanResult.getIsScanning;
                registeredCount++;
            }
            else {
                print("ToolFactory: Skipping scan_objects tool (object detection tool is off)");
            }
        } else {
            print("ToolFactory: Skipping scan_objects tool (missing dependencies)");
        }

        // Register look_at tool if dependencies are available
        if (this.robotDriver && this.assistantMode) {
            llmService.registerTool(createLookAtTool({
                robotDriver: this.robotDriver,
                assistantMode: this.assistantMode,
                roundCoord: (v) => this.roundCoord(v),
                showTemporaryLine: (start, end, duration) => this.showTemporaryLine(start, end, duration),
                lineRendererPrefab: this.lineRendererPrefab,
            }));
            registeredCount++;
        } else {
            print("ToolFactory: Skipping look_at tool (missing dependencies)");
        }

        // Register get_state tool if dependencies are available
        if (this.robotDriver) {
            llmService.registerTool(createGetStateTool({
                robotDriver: this.robotDriver,
                assistantMode: this.assistantMode,
                roundCoord: (v) => this.roundCoord(v),
            }));
            registeredCount++;
        } else {
            print("ToolFactory: Skipping get_state tool (missing dependencies)");
        }

        // Register play_animation and get_available_animations whenever robot is available
        if (this.robotDriver) {
            llmService.registerTool(createPlayAnimationTool({
                robotDriver: this.robotDriver,
                assistantMode: this.assistantMode,
                logDebug: (msg) => this.logDebug(msg),
            }));
            llmService.registerTool(createGetAvailableAnimationsTool(this.robotDriver));
            registeredCount += 2;
        } else {
            print("ToolFactory: Skipping play_animation and get_available_animations (missing robotDriver)");
        }

        // Register draw_line tool (requires line renderer prefab)
        if (this.lineRendererPrefab) {
            llmService.registerTool(createDrawLineTool({
                robotDriver: this.robotDriver,
                lineRendererPrefab: this.lineRendererPrefab,
                roundCoord: (v) => this.roundCoord(v),
                showTemporaryLine: (start, end, duration) => this.showTemporaryLine(start, end, duration),
            }));
            registeredCount++;
        }
        else {
            print("ToolFactory: Skipping draw_line tool (missing lineRendererPrefab or draw line tool is off)");
        }

        // Register take_picture_robotview only when not in simulation mode (robot has real camera)
        if (this.robotDriver && this.hardwareAdapter && this.assistantMode && !this.robotDriver.getIsSimulationMode()) {
            llmService.registerTool(createTakePictureRobotViewTool({
                robotDriver: this.robotDriver,
                hardwareAdapter: this.hardwareAdapter,
                assistantMode: this.assistantMode,
                roundCoord: (v) => this.roundCoord(v),
                createDelayedCallback: (callback, delaySec) => {
                    const ev = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
                    ev.bind(() => callback());
                    ev.reset(delaySec);
                },
            }));
            registeredCount++;
        } else if (this.robotDriver && this.robotDriver.getIsSimulationMode()) {
            print("ToolFactory: Skipping take_picture_robotview (simulation mode is on)");
        } else {
            print("ToolFactory: Skipping take_picture_robotview (missing robotDriver, hardwareAdapter, or assistantMode)");
        }

        print(`ToolFactory: Registered ${registeredCount} tools`);
    }

    public clearAllMarkers(): void {
        if (this.mlDetector) this.mlDetector.clearAllDetections();
    }

    public getIsScanning(): boolean {
        return this.scanIsScanning ? this.scanIsScanning() : false;
    }

    public getTrackedObjectCount(): number {
        return this.mlDetector ? this.mlDetector.getTrackedObjectNames().length : 0;
    }

    /**
     * Show a temporary curved line between two world positions (world-space).
     * Spawns the line, shows it, then after duration destroys it.
     */
    private showTemporaryLine(start: vec3, end: vec3, duration: number): void {
        if (!this.lineRendererPrefab) return;

        const lineObj = this.lineRendererPrefab.instantiate(null);
        lineObj.getTransform().setWorldPosition(start);

        const renderer = getObjectLinkRenderer(lineObj);
        if (!renderer) {
            print("ToolFactory: Line prefab has no ObjectLinkRenderer, destroying");
            lineObj.destroy();
            return;
        }

        renderer.setLineAndAppear(start, end);

        const delayEvent = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
        delayEvent.bind(() => {
            renderer.destroy();
        });
        delayEvent.reset(duration);
    }
}
