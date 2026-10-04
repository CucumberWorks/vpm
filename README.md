# CucumberWorks VPM

VPM repository for VRChat Creator Companion (VCC) and ALCOM.

- VCC: open <https://cucumberworks.github.io/vpm/> and choose **Add to VCC**.
- ALCOM, or VCC by hand: add the repository URL
  `https://cucumberworks.github.io/vpm/index.json`.

Pre-release versions show only when pre-release packages are turned on in VCC or ALCOM.

| Package | Name |
| --- | --- |
| SoulFlame VRM Exporter | `com.soulflame.vrm-exporter` |

## Adding a version

Upload `com.soulflame.vrm-exporter-<version>.zip` as an asset of the release tagged `<version>`, then run
`node scripts/add-version.mjs <zip>` and commit `index.json` and `index.html`. The script records the zip's
`package.json`, its download URL and its SHA-256, keeps every earlier version, and refuses to change a version
that is already listed. `node scripts/add-version.mjs --check` validates the listing.
