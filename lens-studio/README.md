# AR Controller for Reachy Mini

![Demo GIF](./demo.gif)

Control the **Reachy Mini Lite** robot using **Snap Spectacles** with an AR-based interaction flow.

---

## 🛠 Setup

1. Set up **Reachy Mini Lite**  
   https://github.com/pollen-robotics/reachy_mini

2. Run the **Reachy Mini Python daemon**  
   https://github.com/pollen-robotics/reachy_mini

3. Determine the **local IP** of the machine running the daemon

4. In **Lens Studio**:
   - Select the `DaemonInterface` entity
   - Set **Base URL** to the daemon’s local IP  

   > ⚠️ The Spectacles and the daemon **must be on the same local network**

5. Deploy the Lens to your **Snap Spectacles**

6. Drag the **“Reachy Mini”** button to the center of Reachy  
   (see demo video)

7. Select the button to activate the **“look at”** behavior

---

## Credits

If you use this project, please credit **SensAI** for providing the **HuggingFace × Pollen Robotics Reachy Mini Lite** robot.
