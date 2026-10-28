// Company: Leader Electronics of Europe
// License: MIT
// Created by: Ed Smith 
// Date: 17/08/2026
// Load, create and delete user presets on LeaderPhabrix LPX500 waveform monitor 
// or Phabrix Qx/L/P using Companion/ streamdeck buttons. 
// Requires Rest API to be enabled on device and to be connected to same network as Companion
// User preset buttons are automatically generated when module has connected 


import {
  InstanceBase,
  InstanceStatus,
  combineRgb,
  type CompanionActionDefinitions,
  type CompanionFeedbackDefinitions,
  type CompanionPresetDefinitions,
} from '@companion-module/base'

import type { ModuleConfig } from './config.js'
import { getConfigFields } from './config.js'

// ---- Types ----

type PresetLink = { href: string; rel: string }
type DeviceResponse = { links?: PresetLink[] }

type DevicePreset = {
  id: string
  name: string
  href: string
}

type HealthLevel = 'ok' | 'warn' | 'error'
type HealthState = { level: HealthLevel; message: string; ts: number }

// ---- Constants ----

const CREATE_PRESET_ID = '__create_preset__'
const DELETE_PRESET_ID = '__delete_preset__'
const SUCCESS_TIMEOUT_MS = 10_000

// ---------------------------------------
// MAIN INSTANCE
// ---------------------------------------

export class DynamicLoaderInstance extends InstanceBase<ModuleConfig> {
  private config!: ModuleConfig
  private pollTimer: NodeJS.Timeout | undefined

  private presets: DevicePreset[] = []
  private lastFingerprint = ''

  private deleteHoldTimer: NodeJS.Timeout | null = null
  private deleteHoldInterval: NodeJS.Timeout | null = null
  private deleteHoldStart: number | null = null
  private readonly DELETE_HOLD_MS = 5000

  private createSuccessUntil = 0
  private clearCreatedNameTimer: NodeJS.Timeout | undefined

  private presetHealth = new Map<string, HealthState>()

  // ---------------------------------------
  // INIT
  // ---------------------------------------
  async init(config: ModuleConfig): Promise<void> {
    this.config = config
    this.updateStatus(InstanceStatus.Connecting)

    this.setActionDefinitions(this.buildActions())
    this.setFeedbackDefinitions(this.buildFeedbacks())
    this.setPresetDefinitions({})

    // ---------------------------------------
    // Variable Definitions
    // ---------------------------------------
    this.setVariableDefinitions([
      { variableId: 'create_button_text', name: 'Create Preset button text' },
      { variableId: 'last_created_preset', name: 'Last created preset name' },
      { variableId: 'last_loaded_preset', name: 'Last loaded preset name' },
      { variableId: 'last_deleted_preset', name: 'Last deleted preset name' },
      { variableId: 'delete_hold_countdown', name: 'Delete hold countdown text' },

      // ---- About variables from LPX500/ Qx/L/P device ----
      // Serial number is only available on LPX500 units (at time of writing)
      { variableId: 'currentFirmwareMode', name: 'Current Firmware Mode' },
      { variableId: 'currentSystemMode', name: 'Current System Mode' },
      { variableId: 'device', name: 'Device' },
      { variableId: 'fpgaVersion', name: 'FPGA Version' },
      { variableId: 'imageVersion', name: 'Image Version' },
      { variableId: 'softwareVersion', name: 'Software Version' },
      { variableId: 'softwareBranch', name: 'Software Branch' },
      { variableId: 'softwareNumber', name: 'Software Number' },
      { variableId: 'timeOnUnit', name: 'Time On Unit' },
      { variableId: 'serialNumber', name: 'Serial Number' },

    ])

    // Initial variable state
    this.setVariableValues({
      create_button_text: 'Create Preset',
      last_created_preset: '',
      last_loaded_preset: '',
      last_deleted_preset: '',
      delete_hold_countdown: 'Delete Preset',
    })

    await this.refreshFromDevice()
    this.startPolling()
  }

  // ---------------------------------------
  // DESTROY
  // ---------------------------------------
  async destroy(): Promise<void> {
    this.stopPolling()
    
    this.clearDeleteHold()

    if (this.clearCreatedNameTimer) {
      clearTimeout(this.clearCreatedNameTimer)
      this.clearCreatedNameTimer = undefined
    }
  }

  // ---------------------------------------
  // CONFIG UPDATED
  // ---------------------------------------
  async configUpdated(config: ModuleConfig): Promise<void> {
    this.config = config
    this.stopPolling()

    this.presetHealth.clear()
    this.checkFeedbacks('health_warn', 'health_error')

    this.updateStatus(InstanceStatus.Connecting)

    await this.refreshFromDevice()
    this.startPolling()
  }

  getConfigFields() {
    return getConfigFields()
  }

// ---------------------------------------
  // POLLING
  // ---------------------------------------
  private startPolling(): void {
    const refreshMs = Math.max(1000, this.config.refreshMs || 5000)

    this.pollTimer = setInterval(() => {
      void this.refreshFromDevice()
    }, refreshMs)
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = undefined
  }

  // ---------------------------------------
  // URL HELPERS
  // ---------------------------------------
  private baseUrl(): string {
    return `http://${this.config.host}:${this.config.port}`
  }

  // ---------------------------------------
  // CREATE SUCCESS INDICATOR (10 seconds)
  // ---------------------------------------
  private showCreateSuccessFor10s(presetName: string): void {
    this.setVariableValues({
      create_button_text: `Created: ${presetName}`,
      last_created_preset: presetName,
    })

    this.createSuccessUntil = Date.now() + SUCCESS_TIMEOUT_MS
    this.checkFeedbacks('create_success')

    if (this.clearCreatedNameTimer) {
      clearTimeout(this.clearCreatedNameTimer)
    }

    this.clearCreatedNameTimer = setTimeout(() => {
      this.setVariableValues({ create_button_text: 'Create Preset' })
      this.createSuccessUntil = 0
      this.checkFeedbacks('create_success')
      this.clearCreatedNameTimer = undefined
    }, SUCCESS_TIMEOUT_MS)
  }

  // ---------------------------------------
  // GET PRESET LIST + ABOUT INFO
  // ---------------------------------------
  private async refreshFromDevice(): Promise<void> {
    try {
      const presetListUrl = `${this.baseUrl()}/api/v1/presets/userPresets`
      const res = await fetch(presetListUrl, { method: 'GET' })

      if (!res.ok) {
        const body = await safeReadText(res)
        this.updateStatus(
          InstanceStatus.ConnectionFailure,
          `GET list failed: ${res.status}`
        )
        this.log('warn', `GET User Preset list failed (${res.status}): ${body}`)
        return
      }

      const json = (await res.json()) as DeviceResponse
      const parsed = this.parseLinks(json)

      const fingerprint = JSON.stringify(
        parsed.map((p) => [p.id, p.name, p.href])
      )

      if (fingerprint !== this.lastFingerprint) {
        this.lastFingerprint = fingerprint
        this.presets = parsed

        // Cleanup health entries for deleted presets
        const valid = new Set(this.presets.map((p) => p.id))
        for (const key of this.presetHealth.keys()) {
          if (!valid.has(key)) this.presetHealth.delete(key)
        }

        this.setActionDefinitions(this.buildActions())
        this.setFeedbackDefinitions(this.buildFeedbacks())
        this.setPresetDefinitions(this.buildPresets())

        // Re-check after purge
        this.checkFeedbacks('health_warn', 'health_error')

        // update module variables from about (only a few)
        await this.getAbout()
      }

      this.updateStatus(InstanceStatus.Ok)
    } catch (e: any) {
      this.updateStatus(
        InstanceStatus.ConnectionFailure,
        e?.message ?? String(e)
      )
      this.log(
        'warn',
        `GET User Preset list exception: ${e?.message ?? String(e)}`
      )
    }
  }

  // ---------------------------------------
  // PARSE PRESETS RETURNED FROM DEVICE
  // ---------------------------------------
  private parseLinks(payload: DeviceResponse): DevicePreset[] {
    const links = Array.isArray(payload.links) ? payload.links : []

    return links
      .filter(
        (l) =>
          l &&
          typeof l.href === 'string' &&
          typeof l.rel === 'string' &&
          l.rel !== 'self'
      )
      .map((l) => ({
        id: l.rel,
        name: decodeRelNice(l.rel),
        href: l.href,
      }))
  }

  // ---------------------------------------
  // ACTIONS
  // ---------------------------------------
  private buildActions(): CompanionActionDefinitions {
    const choices = this.presets.map((p) => ({
      id: p.id,
      label: p.name,
    }))

    return {
      // ---- LOAD PRESET ----
      load_preset: {
        name: 'Load preset',
        description: 'Load the selected preset on the device',
        options: [
          {
            type: 'dropdown',
            id: 'presetId',
            label: 'Preset',
            default: choices[0]?.id ?? '',
            choices,
          },
        ],
        callback: async (action) => {
          const presetId = String(action.options.presetId ?? '')
          await this.sendLoad(presetId)
        },
      },

      // ---- LOAD LAST CREATED PRESET ----
      // load the last created preset from the last_created_preset variable
      load_created_preset: {
        name: 'Load created preset',
        description: 'Load the last created preset on the device',
        options: [        ],
        callback: async () => {
          const lastCreated = String(this.getVariableValue('last_created_preset') ?? '')
          await this.sendLoad(encodeRelNice(lastCreated))
        },
      },
      
      // ---- CREATE PRESET ----
      create_preset: {
        name: 'Create Preset',
        description: 'Create a new user preset of the current state on the device',
        options: [],
        callback: async () => {
          await this.createPreset()
        },
      },

      // ---- DELETE PRESET ----
      delete_preset: {
        name: 'Delete Preset',
        description:
          'Delete last loaded user preset on device (does not remove button on panel)',
        options: [],
        callback: async () => {
          await this.deletePreset()
        },
      },

      // ---- DELETE HOLD START ----
      delete_hold_start: {
        name: 'Begin 5s delete hold',
        description: 'Starts the timed hold-to-delete sequence',
        options: [],
        callback: async () => {
        
          this.clearDeleteHold()
            
          this.deleteHoldStart = Date.now()

          const lastLoaded = String(this.getVariableValue('last_loaded_preset') ?? '')
          this.setVariableValues({
            delete_hold_countdown: `Delete ${lastLoaded} in: 5s`,
          })

          this.deleteHoldTimer = setTimeout(async () => {
            await this.deletePreset()
            this.clearDeleteHold()
            this.checkFeedbacks('delete_hold_feedback')
            this.deleteHoldStart = null
            this.deleteHoldTimer = null
          }, this.DELETE_HOLD_MS)

          // Update countdown every 250ms
          this.deleteHoldInterval = setInterval(() => {
            if (!this.deleteHoldStart) {
              if (this.deleteHoldInterval) {
                  clearInterval(this.deleteHoldInterval)
                  this.deleteHoldInterval = null
                }
              this.deleteHoldInterval = null
              return
            }

            const elapsed = Date.now() - this.deleteHoldStart
            const remain = Math.max(0, this.DELETE_HOLD_MS - elapsed)
            const sec = Math.ceil(remain / 1000)

            this.setVariableValues({
              delete_hold_countdown: `Delete ${lastLoaded} in: ${sec}s`,
            })

            if (remain <= 0) {
              if (this.deleteHoldInterval) {
                  clearInterval(this.deleteHoldInterval)
                  this.deleteHoldInterval = null
                }
              this.deleteHoldInterval = null
              this.setVariableValues({ delete_hold_countdown: 'Delete Preset' })
            }
          }, 250)
        },
      },

      // ---- DELETE HOLD CANCEL ----
      delete_hold_cancel: {
        name: 'Cancel delete hold',
        description: 'Cancels delete if user releases early',
        options: [],
        callback: async () => {
          this.clearDeleteHold()
          this.setVariableValues({ delete_hold_countdown: 'Delete Preset' })
          this.checkFeedbacks('delete_hold_feedback')
        },
      },
    }
  }

  // ---------------------------------------
  // DELETE PRESET
  // ---------------------------------------
  private async deletePreset(): Promise<void> {
    try {
      const lastPreset = String(this.getVariableValue('last_loaded_preset') ?? '')
      if (!lastPreset) {
        this.setPresetHealth(DELETE_PRESET_ID, 'warn', 'No last loaded preset')
        return
      }

      const url = `${this.baseUrl()}/api/v1/presets/userPresets/${encodeRelNice(
        lastPreset
      )}`

      const res = await fetch(url, { method: 'DELETE' })

      if (!res.ok) {
        const body = await safeReadText(res)
        this.setPresetHealth(
          DELETE_PRESET_ID,
          'warn',
          `DELETE failed (${res.status}): ${body}`
        )
        return
      }

      // Successful
      this.log('info', `Deleted preset: ${lastPreset}`)
      this.setVariableValues({
        last_deleted_preset: lastPreset,
        delete_hold_countdown: `Deleted Preset: ${lastPreset}`,
      })

      this.clearPresetHealth(DELETE_PRESET_ID)

      await this.refreshFromDevice()
    } catch (e: any) {
      this.setPresetHealth(
        DELETE_PRESET_ID,
        'error',
        `DELETE exception: ${e?.message ?? String(e)}`
      )
    }
  }

  // ---------------------------------------
  // LOAD PRESET
  // ---------------------------------------
  private async sendLoad(presetId: string): Promise<void> {
    const preset = this.presets.find((p) => p.id === presetId)
    if (!preset) {
      this.setPresetHealth(presetId, 'warn', `Preset not found: ${presetId}`)
      return
    }

    try {
      const res = await fetch(preset.href, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'load' }),
      })

      if (!res.ok) {
        const body = await safeReadText(res)
        this.setPresetHealth(
          preset.id,
          'error',
          `PUT failed (${res.status}): ${body}`
        )
        return
      }

      this.clearPresetHealth(preset.id)

      this.log('info', `Loaded preset: ${preset.name}`)
      this.setVariableValues({
        last_loaded_preset: preset.name,
      })
    } catch (e: any) {
      this.setPresetHealth(
        preset.id,
        'error',
        `PUT exception: ${e?.message ?? String(e)}`
      )
    }
  }

  // ---------------------------------------
  // CREATE PRESET
  // ---------------------------------------
  private async createPreset(): Promise<void> {
    try {
      const url = `${this.baseUrl()}/api/v1/presets/userPresets`

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      if (!res.ok) {
        const body = await safeReadText(res)
        this.setPresetHealth(
          CREATE_PRESET_ID,
          'error',
          `POST failed (${res.status}): ${body}`
        )
        return
      }

      const json = (await res.json()) as any
      const presetName = typeof json?.presetName === 'string' ? json.presetName : ''

      if (!presetName) {
        this.setPresetHealth(CREATE_PRESET_ID, 'warn', 'No presetName returned')
        return
      }

      this.clearPresetHealth(CREATE_PRESET_ID)

      this.showCreateSuccessFor10s(presetName)
      this.setVariableValues({ last_created_preset: presetName })
      this.log('info', `Created preset: ${presetName}`)

      await this.refreshFromDevice()
    } catch (e: any) {
      this.setPresetHealth(
        CREATE_PRESET_ID,
        'error',
        `POST exception: ${e?.message ?? String(e)}`
      )
    }
  }
  
  // ---------------------------------------
  // GET ABOUT (populate module variables)
  // ---------------------------------------
  private async getAbout(): Promise<void> {
    try {
      const url = `${this.baseUrl()}/api/v1/system/about`
      const res = await fetch(url, { method: 'GET' })

      if (!res.ok) {
        const body = await safeReadText(res)
        this.updateStatus(
          InstanceStatus.ConnectionFailure,
          `GET about info failed: ${res.status}`
        )
        this.log('warn', `GET about info failed (${res.status}): ${body}`)
        return
      }

      const json = await res.json() as any

      const values: Record<string, any> = {
        currentFirmwareMode: String(json.currentFirmwareMode ?? ''),
        currentSystemMode: String(json.currentSystemMode ?? ''),
        device: String(json.device ?? ''),
        fpgaVersion: String(json.fpgaVersion ?? ''),
        imageVersion: String(json.imageVersion ?? ''),
        softwareBranch: String(json.softwareBranch ?? ''),
        softwareVersion: String(json.softwareVersion ?? ''),
        softwareNumber: String(json.softwareNumber ?? ''),
        timeOnUnit: String(json.timeOnUnit ?? ''),
        serialNumber: String(json.serialNumber ?? ''),
      }

      this.setVariableValues(values)
    } catch (e: any) {
      this.log('error', `GET about exception: ${e?.message ?? String(e)}`)
    }
  }

  // ---------------------------------------
  // FEEDBACK DEFINITIONS
  // ---------------------------------------
  private buildFeedbacks(): CompanionFeedbackDefinitions {
    const choices = this.presets.map((p) => ({ id: p.id, label: p.name }))

    return {
      health_warn: {
        type: 'boolean',
        name: 'Health Warning',
        description: 'Amber background when preset has warning',
        defaultStyle: {
          bgcolor: combineRgb(255, 170, 0),
          color: combineRgb(0, 0, 0),
        },
        options: [
          {
            type: 'dropdown',
            id: 'presetId',
            label: 'Preset',
            default: choices[0]?.id ?? '',
            choices,
          },
        ],
        callback: (fb) =>
          this.presetHealth.get(String(fb.options.presetId ?? ''))?.level ===
          'warn',
      },

      health_error: {
        type: 'boolean',
        name: 'Health Error',
        description: 'Red background when preset has error',
        defaultStyle: {
          bgcolor: combineRgb(255, 0, 0),
          color: combineRgb(255, 255, 255),
        },
        options: [
          {
            type: 'dropdown',
            id: 'presetId',
            label: 'Preset',
            default: choices[0]?.id ?? '',
            choices,
          },
        ],
        callback: (fb) =>
          this.presetHealth.get(String(fb.options.presetId ?? ''))?.level ===
          'error',
      },
      
      create_success: {
        type: 'boolean',
        name: 'Create Preset Success (10s)',
        description:
          'Turns Create button green for 10s after a successful preset create',
        defaultStyle: {
          bgcolor: combineRgb(0, 200, 0),
          color: combineRgb(0, 0, 0),
        },
        options: [],
        callback: () => this.createSuccessUntil > Date.now(),
      },

      delete_hold_feedback: {
        type: 'boolean',
        name: 'Delete Hold Active',
        description: 'Turns button red while user is holding delete',
        defaultStyle: {
          bgcolor: combineRgb(255, 0, 0),
          color: combineRgb(255, 255, 255),
        },
        options: [],
        callback: () => this.deleteHoldStart !== null,
      },
    }
  }

  // ---------------------------------------
  // PRESET DEFINITIONS (buttons)
  // ---------------------------------------
  private buildPresets(): CompanionPresetDefinitions {
    const defs: CompanionPresetDefinitions = {}

    // ---- DELETE BUTTON ----
    defs['delete_preset'] = {
      type: 'button',
      category: 'User Presets',
      name: 'Delete Preset',
      style: {
        text: '$(generic-module:delete_hold_countdown)',
        size: 'auto',
        color: combineRgb(255, 255, 255),
        bgcolor: combineRgb(20, 20, 20),
      },
      steps: [
        { down: [{ actionId: 'delete_hold_start', options: {} }], up: [{ actionId: 'delete_hold_cancel', options: {} }] },
      ],
      feedbacks: [
        { feedbackId: 'delete_hold_feedback', options: {} },
        {
          feedbackId: 'health_warn',
          options: { presetId: DELETE_PRESET_ID },
          style: { bgcolor: combineRgb(255, 170, 0), color: combineRgb(0, 0, 0) },
        },
        {
          feedbackId: 'health_error',
          options: { presetId: DELETE_PRESET_ID },
          style: { bgcolor: combineRgb(255, 0, 0), color: combineRgb(255, 255, 255) },
        },
      ],
    }

    // ---- CREATE BUTTON ----
    defs['create_preset'] = {
      type: 'button',
      category: 'User Presets',
      name: 'Create Preset',
      style: {
        text: '$(generic-module:create_button_text)',
        size: 'auto',
        color: combineRgb(255, 255, 255),
        bgcolor: combineRgb(20, 20, 20),
      },
      steps: [{ down: [{ actionId: 'create_preset', options: {} }], up: [] }],
      feedbacks: [
        { feedbackId: 'create_success', options: {} },
        {
          feedbackId: 'health_warn',
          options: { presetId: CREATE_PRESET_ID },
          style: { bgcolor: combineRgb(255, 170, 0), color: combineRgb(0, 0, 0) },
        },
        {
          feedbackId: 'health_error',
          options: { presetId: CREATE_PRESET_ID },
          style: { bgcolor: combineRgb(255, 0, 0), color: combineRgb(255, 255, 255) },
        },
      ],
    }

    // ---- STATUS BUTTONS (read-only) ----
    // last created button can be used to load the last created preset from the last_created_preset variable
    defs['last_created_preset_status'] = {
      type: 'button',
      category: 'User Presets',
      name: 'Last Created Preset Name',
      style: {
        text: 'Last Created Preset: $(generic-module:last_created_preset)',
        size: 'auto',
        color: combineRgb(255, 255, 255),
        bgcolor: combineRgb(102, 0, 102),
      },
      steps: [{ down: [{ actionId: 'load_created_preset', options: { } }], up: [] }],
      feedbacks: [       ],
    }

    defs['last_deleted_preset_status'] = {
      type: 'button',
      category: 'User Presets',
      name: 'Last Deleted Preset Name',
      style: {
        text: 'Last Deleted Preset: $(generic-module:last_deleted_preset)',
        size: 'auto',
        color: combineRgb(255, 255, 255),
        bgcolor: combineRgb(102, 0, 102),
      },
      steps: [{ down: [], up: [] }],
      feedbacks: [],
    }

    defs['last_loaded_preset_status'] = {
      type: 'button',
      category: 'User Presets',
      name: 'Last Loaded Preset Name',
      style: {
        text: 'Last Loaded Preset: $(generic-module:last_loaded_preset)',
        size: 'auto',
        color: combineRgb(255, 255, 255),
        bgcolor: combineRgb(102, 0, 102),
      },
      steps: [{ down: [], up: [] }],
      feedbacks: [],
    }

    // ---- USER PRESETS ----
    for (const p of this.presets) {
      defs[`load_${p.id}`] = {
        type: 'button',
        category: 'User Presets',
        name: `Load ${p.name}`,
        style: {
          text: p.name,
          size: 'auto',
          color: combineRgb(255, 255, 255),
          bgcolor: combineRgb(0, 102, 204),
        },
        steps: [{ down: [{ actionId: 'load_preset', options: { presetId: p.id } }], up: [] }],
        feedbacks: [
          {
            feedbackId: 'health_warn',
            options: { presetId: p.id },
            style: { bgcolor: combineRgb(255, 170, 0), color: combineRgb(0, 0, 0) },
          },
          {
            feedbackId: 'health_error',
            options: { presetId: p.id },
            style: { bgcolor: combineRgb(255, 0, 0), color: combineRgb(255, 255, 255) },
          },
        ],
      }
    }

    return defs
  }

  //----------------------------------------
  // Clear Delete Hold timers HELPER
  // ---------------------------------------
  private clearDeleteHold(): void {
  if (this.deleteHoldTimer) {
    clearTimeout(this.deleteHoldTimer)
    this.deleteHoldTimer = null
  }

  if (this.deleteHoldInterval) {
    clearInterval(this.deleteHoldInterval)
    this.deleteHoldInterval = null
  }

  this.deleteHoldStart = null
}
  //----------------------------------------
  // HEALTH HELPERS
  // ---------------------------------------
  private setPresetHealth(presetId: string, level: HealthLevel, message: string): void {
    if (!presetId) return

    if (level === 'ok') {
      this.presetHealth.delete(presetId)
    } else {
      this.presetHealth.set(presetId, { level, message, ts: Date.now() })
    }

    this.checkFeedbacks('health_warn', 'health_error')
  }

  private clearPresetHealth(presetId: string): void {
    this.setPresetHealth(presetId, 'ok', '')
  }
}

// ---------------------------------------
// UTILITY HELPERS
// ---------------------------------------
function decodeRelNice(rel: string): string {
  try {
    const once = decodeURIComponent(rel)
    try {
      return decodeURIComponent(once)
    } catch {
      return once
    }
  } catch {
    return rel
  }
}

function encodeRelNice(rel: string): string {
  try {
    const once = encodeURIComponent(rel)
    try {
      return encodeURIComponent(once)
    } catch {
      return once
    }
  } catch {
    return rel
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
