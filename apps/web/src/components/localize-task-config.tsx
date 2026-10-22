"use client"

import { useState, type ReactNode } from "react"
import { ArrowRightLeft, AudioWaveform, Captions, Clapperboard, Languages, Layers, Mic, Speech, type LucideIcon } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Segmented } from "@/components/ui/segmented"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import type { Capability, ModelCapability, ModelSelection, Runtime, TaskConfig, TtsSelection } from "@/plugin/builtin/localize-contracts"
import { useText, type Text } from "@/lib/i18n"

const OUTPUT_LABELS: Record<TaskConfig["output_mode"], [string, string, string?]> = {
  subtitles: ["Subtitles · original audio", "Subtitles · original audio", "ចំណងជើង · សំឡេងដើម"],
  dubbing: ["Dubbing", "Dubbing", "បញ្ចូលសំឡេង"],
  both: ["Dubbing and subtitles", "Dubbing and subtitles", "បញ្ចូលសំឡេង និងចំណងជើង"],
}

const LANGUAGE_NAMES: Record<string, string> = { en: "English", zh: "Chinese", ja: "Japanese", km: "Khmer" }

function languageName(code: string, text: Text) {
  if (code === "auto") return text("Auto detect", "自动识别", "\u179F\u17D2\u179C\u17D0\u1799\u1794\u17D2\u179A\u179C\u178F\u17D2\u178F\u17B7")
  return LANGUAGE_NAMES[code] ?? code
}

function deviceName(device: string, text: Text, runtime: Runtime) {
  if (device === "cpu") return "CPU"
  if (device === "remote") return text("Remote", "远端", "បណ្ដាញ")
  if (device === "mps") return "Apple MPS"
  const entry = runtime.devices.find(item => item.id === device)
  if (entry?.backend === "rocm") return `AMD ROCm ${device.split(":")[1]}`
  return device.replace(/^cuda:/, "CUDA ")
}

type Kind = Capability["capability"]
type Choice = { value: ModelSelection; model: ModelCapability }

function choices(runtime: Runtime, kind: Kind): Choice[] {
  return runtime.capabilities.filter((item) => item.capability === kind && item.available).flatMap((item) => (
    item.models.flatMap((model) => model.devices.filter((device) => (
      item.execution === "remote" ? device === "remote" : runtime.devices.some((entry) => entry.id === device && entry.available)
    )).map((device) => ({ value: { adapter: item.adapter, model: model.id, device: device as ModelSelection["device"] }, model })))
  ))
}

function selectionKey(value: ModelSelection | null) {
  return value ? JSON.stringify([value.adapter, value.model, value.device]) : ""
}

function firstSelection(runtime: Runtime, kind: Kind): ModelSelection {
  return choices(runtime, kind)[0]?.value ?? { adapter: "", model: "", device: "cpu" }
}

function selectedModel(runtime: Runtime, kind: Kind, value: ModelSelection | null) {
  return choices(runtime, kind).find((item) => selectionKey(item.value) === selectionKey(value))?.model
}

function prefersSourceClone(value: ModelSelection, model: ModelCapability | undefined) {
  return value.adapter === "voxcpm" && value.model === "VoxCPM2" && model?.voice_modes.includes("source_clone")
}

function selectTts(runtime: Runtime, value: ModelSelection, target: string): TtsSelection {
  const model = selectedModel(runtime, "tts", value)
  return { ...value, voice: !prefersSourceClone(value, model) && model?.voice_modes.includes("preset")
    ? { mode: "preset", id: model.voices.find((item) => item.languages.includes(target))?.id ?? "" }
    : { mode: "source_clone" } }
}

function firstTts(runtime: Runtime, target: string): TtsSelection {
  const preferred = choices(runtime, "tts").find((item) => prefersSourceClone(item.value, item.model) && item.model.target_languages.includes(target))
  return selectTts(runtime, preferred?.value ?? firstSelection(runtime, "tts"), target)
}

function normalize(config: TaskConfig, runtime: Runtime): TaskConfig {
  if (config.output_mode === "subtitles") return { ...config, keep_background: false, tts: null, separation: null, subtitle_alignment: null }
  const tts = config.tts ?? firstTts(runtime, config.target_language)
  const needsSeparation = config.keep_background || tts.voice.mode === "source_clone"
  return { ...config, tts, separation: needsSeparation ? config.separation ?? firstSelection(runtime, "separation") : null,
    subtitle_alignment: config.output_mode === "both" ? config.subtitle_alignment ?? null : null }
}

// 原文 / 目标语言的可选项，随所选识别、翻译与配音模型变化。
function languageChoices(config: TaskConfig, runtime: Runtime) {
  const asr = selectedModel(runtime, "asr", config.asr)
  const translation = selectedModel(runtime, "translation", config.translation)
  const tts = selectedModel(runtime, "tts", config.tts)
  return {
    sources: asr?.source_languages.filter((item) => item === "auto" || translation?.source_languages.includes(item)) ?? [],
    targets: translation?.target_languages.filter((item) => item !== config.source_language && (!config.tts || tts?.target_languages.includes(item))) ?? [],
  }
}

function updateConfig(config: TaskConfig, patch: Partial<TaskConfig>, runtime: Runtime) {
  return normalize({ ...config, ...patch }, runtime)
}

// The product's default target language is Khmer — the audience this localized
// build serves; Chinese and English stay selectable in the To-language list.
function defaultTargetLanguage() {
  return "km"
}

export function initialTaskConfig(runtime: Runtime, defaults?: Partial<TaskConfig> | null): TaskConfig {
  return {
    source_language: "auto", target_language: defaultTargetLanguage(), output_mode: "subtitles", keep_background: false,
    tts: null, separation: null, subtitle_alignment: null, trim: null, chunk_minutes: null,
    ...defaults,
    asr: defaults?.asr ?? firstSelection(runtime, "asr"),
    translation: defaults?.translation ?? firstSelection(runtime, "translation"),
  }
}

export function TaskOptions({ value, runtime, onChange }: {
  value: TaskConfig; runtime: Runtime; onChange: (value: TaskConfig) => void
}) {
  const text = useText()
  // Keep the configured models when a task temporarily switches to subtitles.
  const [defaults] = useState(value)
  const { sources, targets } = languageChoices(value, runtime)
  function change(patch: Partial<TaskConfig>) {
    const next = { ...value, ...patch }
    if (patch.output_mode && patch.output_mode !== "subtitles") {
      next.tts ??= defaults.tts
      next.keep_background = defaults.keep_background
      next.separation ??= defaults.separation
      if (patch.output_mode === "both") next.subtitle_alignment ??= defaults.subtitle_alignment
    }
    onChange(normalize(next, runtime))
  }
  const fields = [
    { id: "output-mode", label: text("Output", "输出", "\u179B\u1791\u17D2\u1792\u1795\u179B"), aria: text("Output content", "输出内容", "\u1781\u17D2\u179B\u17B9\u1798\u179F\u17B6\u179A\u179B\u1791\u17D2\u1792\u1795\u179B"), value: value.output_mode, hint: "",
      display: text(...OUTPUT_LABELS[value.output_mode]), options: Object.entries(OUTPUT_LABELS).map(([mode, label]) => ({ value: mode, label: text(...label) })),
      change: (mode: string) => change({ output_mode: mode as TaskConfig["output_mode"] }) },
    { id: "source-language", label: text("From", "原文", "\u1794\u17D2\u179A\u1797\u1796"), aria: text("Source language", "原文语言", "\u1797\u17B6\u179F\u17B6\u1794\u17D2\u179A\u1797\u1796"), value: value.source_language, hint: "",
      display: languageName(value.source_language, text), options: sources.map((code) => ({ value: code, label: languageName(code, text) })),
      change: (source_language: string) => change({ source_language }) },
    { id: "target-language", label: text("To", "目标", "\u1791\u17C5"), aria: text("Target language", "目标语言", "\u1797\u17B6\u179F\u17B6\u1782\u17C4\u179B\u178A\u17C5"), value: value.target_language,
      display: languageName(value.target_language, text), options: targets.map((code) => ({ value: code, label: languageName(code, text) })),
      change: (target_language: string) => change({ target_language }),
      // With no translation provider configured the list would be empty and the
      // stale default value would look like the only possibility — say why.
      hint: targets.length === 0 ? text("Connect a translation provider in Settings first.", "请先在设置中连接翻译服务。", "សូមតភ្ជាប់ក្រុមហ៊ុնផ្ដល់សេវាបកប្រែនៅក្នុងការកំណត់ជាដំបូង។") : "" },
  ]
  return <div className="flex flex-wrap items-center gap-2">{fields.map((field) => (
    <Select key={field.id} value={field.value} onValueChange={(next) => { if (typeof next === "string") field.change(next) }}>
      <SelectTrigger id={field.id} aria-label={field.aria} className="inline-flex h-8 w-auto max-w-full gap-1.5 rounded-full border-border bg-muted px-3 text-[13px] shadow-none hover:bg-accent" title={field.hint || undefined}>
        <span className="text-subtle-foreground">{field.label}</span>{field.hint && <span aria-hidden className="h-2 w-2 rounded-full bg-status-warning-fg" />}<span className="min-w-0 truncate font-medium">{field.display}</span>
      </SelectTrigger>
      <SelectContent>{field.options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
    </Select>
  ))}<PartsFields value={value.chunk_minutes ?? null} onChange={(chunk_minutes) => change({ chunk_minutes })} compact />{fields.some((field) => field.hint) && <p className="text-xs text-status-warning-fg">{fields.find((field) => field.hint)!.hint}</p>}</div>
}

const ADAPTER_NAMES: Record<string, [string, string, string?]> = {
  whisper: ["Whisper", "Whisper", "Whisper"],
  openai: ["OpenAI-compatible", "OpenAI 兼容", "OpenAI ត្រូវគ្នា"],
  nllb: ["NLLB-200", "NLLB-200", "NLLB-200"],
  hy_mt: ["Tencent HY-MT", "腾讯 HY-MT", "Tencent HY-MT"],
  edge: ["Edge TTS", "Edge TTS", "Edge TTS"],
  voxcpm: ["VoxCPM", "VoxCPM", "VoxCPM"],
  demucs: ["Demucs", "Demucs", "Demucs"],
  qwen_forced_aligner: ["Qwen", "Qwen", "Qwen"],
}

function adapterName(adapter: string, text: Text) {
  const name = ADAPTER_NAMES[adapter]
  return name ? text(...name) : adapter
}

// 模型名为主，适配器与设备作为次要信息。
function ModelLabel({ value, text, runtime }: { value: ModelSelection; text: Text; runtime: Runtime }) {
  return <span className="min-w-0 truncate">
    <span className="font-medium text-foreground">{value.model}</span>{" "}
    <span className="text-subtle-foreground">{value.device === "remote"
      ? text("Remote API", "远端接口", "ចំណុចប្រទាក់បណ្ដាញ")
      : `${adapterName(value.adapter, text)} · ${deviceName(value.device, text, runtime)}`}</span>
  </span>
}

const ESTIMATE_TIMING = "estimate"

// 每组设置用一种 logo 色点缀图标。
const TINTS = {
  neutral: "bg-accent text-muted-foreground",
  blue: "bg-[rgb(0_174_236/0.14)] text-[#0277b5] dark:text-[#5ccbf5]",
  violet: "bg-[rgb(124_140_255/0.16)] text-[#5550d6] dark:text-[#a9b1ff]",
  teal: "bg-[rgb(45_212_191/0.15)] text-[#0f8a80] dark:text-[#5eead4]",
  red: "bg-[rgb(255_0_51/0.12)] text-[#d70a3c] dark:text-[#ff7a96]",
  pink: "bg-[rgb(251_114_153/0.15)] text-[#d6336c] dark:text-[#ff9dbb]",
}

type Option = { value: string; label: ReactNode; disabled?: boolean }

function ConfigRow({ icon: Icon, tint, title, description, children }: {
  icon: LucideIcon; tint: keyof typeof TINTS; title: string; description: string; children: ReactNode
}) {
  return <div className="grid gap-3 py-5 @2xl:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] @2xl:gap-6">
    <div className="flex items-start gap-3">
      <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", TINTS[tint])}><Icon className="size-4" /></span>
      <div className="min-w-0">
        <p className="text-[13px] leading-5 font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
    </div>
    <div className="grid min-w-0 content-start gap-3 @lg:grid-cols-2">{children}</div>
  </div>
}

// 可见的是简短说明；srPrefix 补全读屏时的完整名称（如“语音识别模型”）。
function Field({ id, caption, srPrefix, className, children }: {
  id?: string; caption: string; srPrefix?: string; className?: string; children: ReactNode
}) {
  const label = <>{srPrefix ? <span className="sr-only">{srPrefix}</span> : null}{caption}</>
  return <div className={cn("min-w-0 space-y-1.5", className)}>
    {id ? <Label htmlFor={id} className="flex h-5 items-center text-xs font-medium text-muted-foreground">{label}</Label>
      : <p className="flex h-5 items-center text-xs font-medium text-muted-foreground">{label}</p>}
    {children}
  </div>
}

function FieldSelect({ id, value, display, placeholder, options, onChange }: {
  id: string; value: string; display: ReactNode | null; placeholder: string; options: Option[]; onChange: (value: string) => void
}) {
  return <Select value={value} onValueChange={(next) => { if (typeof next === "string") onChange(next) }}>
    <SelectTrigger id={id}>
      <span className={cn("flex min-w-0 truncate text-left", !display && "text-subtle-foreground")}>{display ?? placeholder}</span>
    </SelectTrigger>
    <SelectContent>
      {options.map((option) => <SelectItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>)}
    </SelectContent>
  </Select>
}

function ModelField({ kind, id, caption, srPrefix, value, runtime, onChange }: {
  kind: Kind; id: string; caption: string; srPrefix: string; value: ModelSelection | null; runtime: Runtime; onChange: (value: ModelSelection) => void
}) {
  const text = useText()
  const options = choices(runtime, kind)
  const selected = selectionKey(value)
  const known = options.some((item) => selectionKey(item.value) === selected)
  return <Field id={id} caption={caption} srPrefix={srPrefix}>
    <FieldSelect id={id} value={selected}
      display={value?.model ? <>
        <ModelLabel value={value} text={text} runtime={runtime} />
        {known ? null : <span className="ml-1.5 shrink-0 text-status-warning-fg">· {text("Unavailable", "不可用", "\u1798\u17B7\u1793\u17A2\u17B6\u1785\u1794\u17D2\u179A\u17BE\u1794\u17B6\u1793")}</span>}
      </> : null}
      placeholder={text("Select a model", "选择模型", "ជ្រើសរើសម៉ូដែល")}
      options={[
        ...options.map((item) => ({ value: selectionKey(item.value), label: <ModelLabel value={item.value} text={text} runtime={runtime} /> })),
        ...runtime.capabilities.filter((item) => item.capability === kind && !item.available).map((item) => ({
          value: `unavailable-${item.adapter}`, label: `${item.adapter} — ${item.unavailable_reason ?? text("Unavailable", "不可用", "\u1798\u17B7\u1793\u17A2\u17B6\u1785\u1794\u17D2\u179A\u17BE\u1794\u17B6\u1793")}`, disabled: true,
        })),
      ]}
      onChange={(next) => {
        const match = options.find((item) => selectionKey(item.value) === next)
        if (match) onChange(match.value)
      }} />
  </Field>
}

function LanguageField({ id, caption, value, options, onChange }: {
  id: string; caption: string; value: string; options: string[]; onChange: (value: string) => void
}) {
  const text = useText()
  return <Field id={id} caption={caption}>
    <FieldSelect id={id} value={value} display={value ? languageName(value, text) : null}
      placeholder={text("Select a language", "选择语言", "ជ្រើសរើសភាសា")}
      options={options.map((item) => ({ value: item, label: languageName(item, text) }))} onChange={onChange} />
  </Field>
}

const WHOLE_VIDEO = "whole"
const PART_MINUTES = Array.from({ length: 60 }, (_, index) => index + 1)

// Long videos are rendered in short parts and joined into one complete video,
// which keeps every FFmpeg call small and the progress steady.
function PartsFields({ value, onChange, compact = false }: {
  value: number | null; onChange: (value: number | null) => void; compact?: boolean
}) {
  const text = useText()
  const options = [
    { value: WHOLE_VIDEO, label: text("Whole video", "完整视频", "វីដេអូទាំងមូល") },
    ...PART_MINUTES.map((minutes) => ({ value: String(minutes), label: `${minutes} ${text("min", "分钟", "នាទី")}` })),
  ]
  const current = value ? String(value) : WHOLE_VIDEO
  const display = value ? `${value} ${text("min", "分钟", "នាទី")}` : text("Whole video", "完整视频", "វីដេអូទាំងមូល")
  const set = (next: string) => onChange(next === WHOLE_VIDEO ? null : Number(next))
  if (compact) return <Select value={current} onValueChange={(next) => { if (typeof next === "string") set(next) }}>
    <SelectTrigger aria-label={text("Render parts", "分段渲染", "ដំណើរការជាផ្នែកៗ")} className="inline-flex h-8 w-auto max-w-full gap-1.5 rounded-full border-border bg-muted px-3 text-[13px] shadow-none hover:bg-accent">
      <Layers className="size-3.5 text-subtle-foreground" />
      <span className="text-subtle-foreground">{text("Parts", "分段", "ផ្នែក")}</span>
      <span className="min-w-0 truncate font-medium">{display}</span>
    </SelectTrigger>
    <SelectContent>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
  </Select>
  return <Field id="part-length" caption={text("Part length", "分段时长", "ប្រវែងផ្នែក")} srPrefix={text("Render parts ", "分段渲染", "ដំណើរការជាផ្នែកៗ ")}>
    <FieldSelect id="part-length" value={current} display={display} placeholder={display} options={options} onChange={set} />
  </Field>
}

export function TaskConfigForm({ value, runtime, onChange }: {
  value: TaskConfig; runtime: Runtime; onChange: (value: TaskConfig) => void
}) {
  const text = useText()
  const tts = selectedModel(runtime, "tts", value.tts)
  const { sources, targets } = languageChoices(value, runtime)
  const alignmentOptions = choices(runtime, "subtitle_alignment").filter((item) => item.model.target_languages.includes(value.target_language))
  const alignmentKey = selectionKey(value.subtitle_alignment ?? null)
  const alignmentKnown = alignmentOptions.some((item) => selectionKey(item.value) === alignmentKey)
  const change = (patch: Partial<TaskConfig>) => onChange(updateConfig(value, patch, runtime))
  const presetVoices = tts?.voices.filter((voice) => voice.languages.includes(value.target_language)) ?? []
  const voice = value.tts?.voice
  const voiceModes = tts?.voice_modes ?? []
  const voiceModeLabel = (mode: string) => mode === "preset" ? text("Preset voice", "预设声音", "សំឡេងកំណត់ស្រាប់") : text("Clone source voice", "克隆源音色", "ក្លូនសំឡេងដើម")
  const dubbing = value.output_mode !== "subtitles"

  return <div className="@container divide-y divide-border">
      <ConfigRow icon={Clapperboard} tint="neutral" title={text("Output", "输出", "\u179B\u1791\u17D2\u1792\u1795\u179B")}
        description={text("Subtitles, a dubbed cut, or both.", "生成字幕、配音成片，或两者都要。", "ចំណងជើង ឬភាពយន្តបញ្ចូលសំឡេង ឬទាំងពីរ។")}>
        <Field id="output-mode" caption={text("Content", "内容", "\u1798\u17B6\u178F\u17B7\u1780\u17B6")} srPrefix={text("Output ", "输出", "\u179B\u1791\u17D2\u1792\u1795\u179B ")}>
          <FieldSelect id="output-mode" value={value.output_mode} display={text(...OUTPUT_LABELS[value.output_mode])} placeholder=""
            options={Object.entries(OUTPUT_LABELS).map(([mode, label]) => ({ value: mode, label: text(...label) }))}
            onChange={(next) => change({ output_mode: next as TaskConfig["output_mode"] })} />
        </Field>
      </ConfigRow>
      <ConfigRow icon={ArrowRightLeft} tint="violet" title={text("Languages", "语言", "\u1797\u17B6\u179F\u17B6")}
        description={text("The spoken language and the one to translate into.", "视频原本的语言，以及要翻译成的语言。", "ភាសាដើមនៃវីដេអូ និងភាសាដែលត្រូវបកប្រែទៅ។")}>
        <LanguageField id="source-language" caption={text("Source language", "原文语言", "\u1797\u17B6\u179F\u17B6\u1794\u17D2\u179A\u1797\u1796")} value={value.source_language} options={sources} onChange={(source_language) => change({ source_language })} />
        <LanguageField id="target-language" caption={text("Target language", "目标语言", "\u1797\u17B6\u179F\u17B6\u1782\u17C4\u179B\u178A\u17C5")} value={value.target_language} options={targets} onChange={(target_language) => change({ target_language })} />
      </ConfigRow>

    <ConfigRow icon={Layers} tint="teal" title={text("Render parts", "分段渲染", "ដំណើរការជាផ្នែកៗ")}
      description={text("The video is rendered in short parts and joined back into one complete video. Short parts use less memory and finish faster.", "视频分段渲染，再合并成一个完整视频。分段更省内存，也能更快完成。", "វីដេអូត្រូវបង្កើតជាផ្នែកខ្លីៗ រួចបញ្ចូលគ្នាជាវីដេអូពេញលេញ។ ផ្នែកខ្លីៗប្រើអង្គចងចាំតិច និងបញ្ចប់លឿនជាង។")}>
      <PartsFields value={value.chunk_minutes ?? null} onChange={(chunk_minutes) => change({ chunk_minutes })} />
    </ConfigRow>

    <ConfigRow icon={Mic} tint="blue" title={text("Speech recognition", "语音识别", "\u1780\u17B6\u179A\u179F\u1798\u17D2\u1782\u17B6\u179B\u17CB\u179F\u17C6\u17A1\u17C1\u1784")}
      description={text("Turns speech into text. Name hints help with people and brands.", "把语音转成文字，专名提示能让人名、品牌名更准确。", "បំលែងសំឡេងទៅជាអត្ថបទ។ ការបំភ័័តឈ្មោះ ជួយឱ្យឈ្មោះមនុស្ស និងម៉ាក់ ភ្ជាប់បានត្រឹមត្រូវ។")}>
      <ModelField kind="asr" id="model-asr" caption={text("Model", "模型", "ម៉ូដែល")} srPrefix={text("Speech recognition ", "语音识别", "\u1780\u17B6\u179A\u179F\u1798\u17D2\u1782\u17B6\u179B\u17CB\u179F\u17C6\u17A1\u17C1\u1784 ")} value={value.asr} runtime={runtime} onChange={(asr) => change({ asr: { ...value.asr, ...asr } })} />
      <Field id="asr-initial-prompt" caption={text("Proper-name hint (optional)", "专名提示（可选）", "ការបំភ័័តឈ្មោះជាក់លាក់ (ស្រេចចិត្ត)")}>
        <div className="relative">
          <Input id="asr-initial-prompt" maxLength={500} value={value.asr.initial_prompt ?? ""} aria-describedby="asr-initial-prompt-help" className="pr-16"
            placeholder={text("e.g. dubvibe_mini, Jensen Huang", "例如：dubvibe_mini、黄仁勋", "ឧ. dubvibe_mini, Jensen Huang")}
            onChange={(event) => change({ asr: { ...value.asr, initial_prompt: event.target.value || null } })} />
          <span aria-hidden="true" className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs tabular-nums text-subtle-foreground">{value.asr.initial_prompt?.length ?? 0}/500</span>
        </div>
        <p id="asr-initial-prompt-help" className="sr-only">{text("Add people or brand names to help speech recognition. Up to 500 characters.", "填写人名、品牌名，帮助语音识别。最多 500 字。", "បំពេញឈ្មោះមនុស្ស ឬឈ្មោះម៉ាក ជួយការសម្គាល់សំឡេង។ អតិបរមា 500 តួអក្សរ។")}</p>
      </Field>
    </ConfigRow>

    <ConfigRow icon={Languages} tint="violet" title={text("Translation", "翻译", "\u1780\u17B6\u179A\u1794\u1780\u1794\u17D2\u179A\u17C2")}
      description={text("Translates the transcript sentence by sentence.", "逐句翻译识别出的原文。", "បកប្រែអត្ថបទដើមម្តងមួយឃ្លា។")}>
      <ModelField kind="translation" id="model-translation" caption={text("Model", "模型", "ម៉ូដែល")} srPrefix={text("Translation ", "翻译", "\u1780\u17B6\u179A\u1794\u1780\u1794\u17D2\u179A\u17C2 ")} value={value.translation} runtime={runtime} onChange={(translation) => change({ translation })} />
    </ConfigRow>

    {value.output_mode === "both" ? <ConfigRow icon={Captions} tint="teal" title={text("Subtitles", "字幕", "\u17A2\u1780\u17D2\u179F\u179A\u179A\u1784")}
      description={text("Qwen can align subtitles to the generated speech, keeping full-sentence dubbing.", "Qwen 可以按生成的配音对齐字幕，仍保持整句配音。", "Qwen អាចតម្រឹមចំណងជើងទៅនឹងសំឡេងបញ្ចូល ដើម្បីរក្សាការបញ្ចូលសំឡេងម្តងមួយឃ្លា។")}>
      <Field id="subtitle-alignment" caption={text("Timing", "时间", "ពេលវេលា")} srPrefix={text("Subtitle ", "字幕", "ចំណងជើង ")}>
        <FieldSelect id="subtitle-alignment" value={value.subtitle_alignment ? alignmentKey : ESTIMATE_TIMING}
          display={value.subtitle_alignment
            ? `${value.subtitle_alignment.model} · ${alignmentKnown ? deviceName(value.subtitle_alignment.device, text, runtime) : text("Unavailable", "不可用", "\u1798\u17B7\u1793\u17A2\u17B6\u1785\u1794\u17D2\u179A\u17BE\u1794\u17B6\u1793")}`
            : text("Estimate by text length", "按字数估算", "ប៉ាន់ស្មានតាមប្រវែងអត្ថបទ")}
          placeholder=""
          options={[
            { value: ESTIMATE_TIMING, label: text("Estimate by text length", "按字数估算", "ប៉ាន់ស្មានតាមប្រវែងអត្ថបទ") },
            ...alignmentOptions.map((item) => ({ value: selectionKey(item.value), label: `${item.value.model} · ${deviceName(item.value.device, text, runtime)}` })),
            ...runtime.capabilities.filter((item) => item.capability === "subtitle_alignment" && !item.available).map((item) => ({
              value: `unavailable-${item.adapter}`, label: `Qwen — ${item.unavailable_reason ?? text("Unavailable", "不可用", "\u1798\u17B7\u1793\u17A2\u17B6\u1785\u1794\u17D2\u179A\u17BE\u1794\u17B6\u1793")}`, disabled: true,
            })),
          ]}
          onChange={(next) => change({ subtitle_alignment: alignmentOptions.find((item) => selectionKey(item.value) === next)?.value ?? null })} />
      </Field>
    </ConfigRow> : null}

    {dubbing ? <ConfigRow icon={Speech} tint="red" title={text("Dubbing", "配音", "បញ្ចូលសំឡេង")}
      description={text("Speaks the translation in the target language.", "用目标语言为译文配音。", "អានការបកប្រែជាភាសាគោលដៅ។")}>
      <ModelField kind="tts" id="model-tts" caption={text("Model", "模型", "ម៉ូដែល")} srPrefix={text("Voice ", "配音", "\u179F\u17C6\u17A1\u17C1\u1784 ")} value={value.tts} runtime={runtime} onChange={(selection) => change({ tts: selectTts(runtime, selection, value.target_language) })} />
      {value.tts && voice ? <Field caption={text("Voice source", "声音方式", "ប្រភពសំឡេង")}>
        {voiceModes.length > 1 ? (
          <Segmented ariaLabel={text("Voice source", "声音方式", "ប្រភពសំឡេង")} value={voice.mode} className="flex h-10 w-full"
            options={voiceModes.map((mode) => ({ value: mode, label: voiceModeLabel(mode) }))}
            onChange={(mode) => change({ tts: { ...value.tts!, voice: mode === "source_clone"
              ? { mode: "source_clone" } : { mode: "preset", id: presetVoices[0]?.id ?? "" } } })} />
        ) : (
          <div role="group" aria-label={text("Voice source", "声音方式", "ប្រភពសំឡេង")}
            className={cn("flex h-10 items-center rounded-lg border border-input bg-input-bg px-3 text-sm", !voiceModes.includes(voice.mode) && "text-status-warning-fg")}>
            {voiceModes.includes(voice.mode) ? voiceModeLabel(voice.mode) : text("Unavailable", "不可用", "\u1798\u17B7\u1793\u17A2\u17B6\u1785\u1794\u17D2\u179A\u17BE\u1794\u17B6\u1793")}
          </div>
        )}
      </Field> : null}
      {value.tts && voice?.mode === "preset" ? <Field id="voice-id" caption={text("Voice", "声音", "\u179F\u17C6\u17A1\u17C1\u1784")}>
        <FieldSelect id="voice-id" value={voice.id} display={presetVoices.find((item) => item.id === voice.id)?.name ?? null}
          placeholder={text("Select a voice", "选择声音", "ជ្រើសរើសសំឡេង")}
          options={presetVoices.map((item) => ({ value: item.id, label: item.name }))}
          onChange={(id) => change({ tts: { ...value.tts!, voice: { mode: "preset", id } } })} />
      </Field> : null}
    </ConfigRow> : null}

    {dubbing ? <ConfigRow icon={AudioWaveform} tint="pink" title={text("Vocal separation", "人声分离", "\u1780\u17B6\u179A\u1789\u17C2\u1780\u179F\u17C6\u17A1\u17C1\u1784")}
      description={text("Separates the voice from music and ambience, for voice cloning and keeping the background.", "把人声和背景声分开，用于克隆音色和保留背景音。", "បំបែកសំឡេងមនុស្សចេញពីតន្ត្រី និងបរិយាកាស សម្រាប់ក្លូនសំឡេង និងរក្សាសំឡេងផ្ទៃរងំ។")}>
      <Field caption={text("Background audio", "背景音", "\u179F\u17C6\u17A1\u17C1\u1784\u1795\u17D2\u1791\u17C3\u1781\u17B6\u1784\u1780\u17D2\u179A\u17C4\u1799")}>
        <label className="flex h-10 cursor-pointer items-center justify-between gap-3 rounded-lg border border-input bg-input-bg px-3 text-sm">
          <span id="keep-background-label">{text("Keep background audio", "保留背景音", "រក្សាទុកសំឡេងផ្ទៃរងំ")}</span>
          <Switch aria-labelledby="keep-background-label" checked={value.keep_background} onCheckedChange={(checked) => change({ keep_background: checked })} />
        </label>
      </Field>
      {value.separation ? <ModelField kind="separation" id="model-separation" caption={text("Model", "模型", "ម៉ូដែល")} srPrefix={text("Audio separation ", "音源分离", "ការបំបែកសំឡេង ")} value={value.separation} runtime={runtime} onChange={(separation) => change({ separation })} /> : null}
    </ConfigRow> : null}
  </div>
}
