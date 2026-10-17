"use client"

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react"

export type UiLanguage = "en" | "km"

const STORAGE_KEY = "youdub-ui-language"

export const LANGUAGE_OPTIONS: { value: UiLanguage; label: string; short: string }[] = [
  { value: "en", label: "English", short: "EN" },
  { value: "km", label: "\u1797\u17B6\u179F\u17B6\u1781\u17D2\u1798\u17C2\u179A", short: "\u1781\u17D2\u1798\u17C2\u179A" },
]

// 外壳与播放器的共享文案；插件内的文案通过 useText 就地给出三种语言。
type Messages = {
  nav: {
    newTask: string
    primary: string
    language: string
    switchToLight: string
    switchToDark: string
    collapseSidebar: string
    expandSidebar: string
  }
  studio: {
    heroTitleLead: string
    heroTitleAccent: string
    heroSubtitle: string
  }
  player: {
    label: string
    play: string
    pause: string
    mute: string
    unmute: string
    volume: string
    seek: string
    speed: string
    fullscreen: string
    exitFullscreen: string
    pip: string
  }
  auth: {
    welcome: string
    showPassword: string
    hidePassword: string
    subtitle: string
    password: string
    signIn: string
    sessionLoading: string
    logout: string
  }
}

const messages: Record<UiLanguage, Messages> = {
  en: {
    nav: {
      newTask: "New task",
      primary: "Main navigation",
      language: "Language",
      switchToLight: "Switch to light",
      switchToDark: "Switch to dark",
      collapseSidebar: "Collapse sidebar",
      expandSidebar: "Expand sidebar",
    },
    studio: {
      heroTitleLead: "Make every video speak",
      heroTitleAccent: "another language",
      heroSubtitle: "Import a local video. dubvibe_mini separates the voice, transcribes, translates and dubs it, then renders subtitles or a dubbed cut.",
    },
    player: {
      label: "Video player",
      play: "Play",
      pause: "Pause",
      mute: "Mute",
      unmute: "Unmute",
      volume: "Volume",
      seek: "Seek",
      speed: "Playback speed",
      fullscreen: "Fullscreen",
      exitFullscreen: "Exit fullscreen",
      pip: "Picture-in-picture",
    },
    auth: {
      welcome: "Welcome back",
      showPassword: "Show password",
      hidePassword: "Hide password",
      subtitle: "Enter the access password configured for this deployment.",
      password: "Password",
      signIn: "Sign in",
      sessionLoading: "Checking your session...",
      logout: "Sign out",
    },
  },
  km: {
    nav: {
      newTask: "\u1794\u1784\u17D2\u1780\u17BE\u178F\u1780\u17B6\u179A\u1784\u17B6\u179A\u1790\u17D2\u1798\u17B8",
      primary: "\u1798\u17C9\u17BA\u1793\u17BB\u1799\u1785\u1798\u17D2\u1794\u1784",
      language: "\u1797\u17B6\u179F\u17B6\u1794\u1784\u17D2\u17A0\u17B6\u1789",
      switchToLight: "\u1794\u17D2\u178F\u17BC\u179A\u1791\u17C5\u1796\u1793\u17D2\u179B\u17BA",
      switchToDark: "\u1794\u17D2\u178F\u17BC\u179A\u1791\u17C5\u1784\u1784\u17B9\u178F",
      collapseSidebar: "\u1794\u17B7\u1791\u179A\u1794\u17B6\u179A\u1785\u17C6\u17A0\u17C0\u1784",
      expandSidebar: "\u1794\u17BE\u1780\u179A\u1794\u17B6\u179A\u1785\u17C6\u17A0\u17C0\u1784",
    },
    studio: {
      heroTitleLead: "\u1792\u17D2\u179C\u17BE\u17B1\u17D2\u1799\u179C\u17B8\u178A\u17C1\u17A2\u17BC\u1782\u17D2\u179A\u1794\u17CB\u1794\u17D2\u179A\u1797\u17C1\u1791",
      heroTitleAccent: "\u1793\u17B7\u1799\u17B6\u1799\u1797\u17B6\u179F\u17B6\u1795\u17D2\u179F\u17C1\u1784\u1791\u17C0\u178F",
      heroSubtitle: "\u1793\u17B6\u17C6\u1785\u17BC\u179B\u179C\u17B8\u178A\u17C1\u17A2\u17BC\u1780\u17D2\u1793\u17BB\u1784\u1798\u17C9\u17B6\u179F\u17CA\u17B8\u1793\u17D4 dubvibe_mini \u1794\u17C6\u1794\u17C2\u1780\u179F\u17C6\u17A1\u17C1\u1784 \u1794\u17D2\u179A\u178F\u17B7\u1785\u17B6\u179A\u17B7\u1780 \u1794\u1780\u1794\u17D2\u179A\u17C2 \u1793\u17B7\u1784\u1794\u1789\u17D2\u1785\u17C1\u1789\u179F\u17C6\u17A1\u17C1\u1784 \u1794\u1793\u17D2\u1791\u17B6\u1794\u17CB\u1798\u1780\u1794\u1784\u17D2\u1780\u17BE\u178F\u17A2\u178F\u17D2\u1790\u1794\u1791\u179A\u1784 \u17AC\u179C\u17B8\u178A\u17C1\u17A2\u17BC\u1794\u1789\u17D2\u1785\u17C1\u1789\u179F\u17C6\u17A1\u17C1\u1784\u17D4",
    },
    player: {
      label: "\u1780\u1798\u17D2\u1798\u179C\u17B7\u1792\u17B8\u1785\u17B6\u1780\u17CB\u179C\u17B8\u178A\u17C1\u17A2\u17BC",
      play: "\u1785\u17B6\u1780\u17CB",
      pause: "\u1795\u17D2\u17A2\u17B6\u1780",
      mute: "\u1794\u17B7\u1791\u179F\u17C6\u17A1\u17C1\u1784",
      unmute: "\u1794\u17BE\u1780\u179F\u17C6\u17A1\u17C1\u1784",
      volume: "\u1780\u1798\u17D2\u179A\u17B7\u178F\u179F\u17C6\u17A1\u17C1\u1784",
      seek: "\u1791\u17B8\u178F\u17B6\u17C6\u1784\u1785\u17B6\u1780\u17CB",
      speed: "\u179B\u17D2\u1794\u17BF\u1793\u1785\u17B6\u1780\u17CB",
      fullscreen: "\u1796\u17C1\u1789\u17A2\u17C1\u1780\u17D2\u179A\u1784\u17CB",
      exitFullscreen: "\u1785\u17C1\u1789\u1796\u17B8\u1796\u17C1\u1789\u17A2\u17C1\u1780\u17D2\u179A\u1784\u17CB",
      pip: "\u179A\u17BC\u1794\u1780\u17D2\u1793\u17BB\u1784\u179A\u17BC\u1794",
    },
    auth: {
      welcome: "\u179F\u17D2\u179C\u17B6\u1782\u1798\u1793\u17CD\u178F\u17D2\u179A\u17A1\u1794\u17CB\u1798\u1780\u179C\u17B7\u1789",
      showPassword: "\u1794\u1784\u17D2\u17A0\u17B6\u1789\u1796\u17B6\u1780\u17D2\u1799\u179F\u1798\u17D2\u1784\u17B6\u178F\u17CB",
      hidePassword: "\u179B\u17B6\u1780\u17CB\u1796\u17B6\u1780\u17D2\u1799\u179F\u1798\u17D2\u1784\u17B6\u178F\u17CB",
      subtitle: "\u1794\u1789\u17D2\u1785\u17BC\u179B\u1796\u17B6\u1780\u17D2\u1799\u179F\u1798\u17D2\u1784\u17B6\u178F\u17CB\u1785\u17BC\u179B\u1794\u17D2\u179A\u17BE\u178A\u17C2\u179B\u1794\u17B6\u1793\u1780\u17C6\u178E\u178F\u17CB\u179F\u1798\u17D2\u179A\u17B6\u1794\u17CB\u1780\u17B6\u179A\u178A\u17B6\u1780\u17CB\u17B1\u17D2\u1799\u1794\u17D2\u179A\u17BE\u1793\u17C1\u17C7\u17D4",
      password: "\u1796\u17B6\u1780\u17D2\u1799\u179F\u1798\u17D2\u1784\u17B6\u178F\u17CB",
      signIn: "\u1785\u17BC\u179B",
      sessionLoading: "\u1780\u17C6\u1796\u17BB\u1784\u1796\u17B7\u1793\u17B7\u178F\u17D2\u1799\u179F\u17D2\u1790\u17B6\u1793\u1797\u17B6\u1796\u1785\u17BC\u179B\u1794\u17D2\u179A\u17BE...",
      logout: "\u1785\u17B6\u1780\u1785\u17C1\u1789",
    },
  },
}

type LanguageContextValue = {
  language: UiLanguage
  setLanguage: (language: UiLanguage) => void
  t: Messages
}

const LanguageContext = createContext<LanguageContextValue | null>(null)

function isLanguage(value: string | null): value is UiLanguage {
  return value === "en" || value === "km"
}

function setDocumentLanguage(language: UiLanguage) {
  document.documentElement.lang = language === "km" ? "km" : "en"
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<UiLanguage>("en")

  const setLanguage = useCallback((next: UiLanguage) => {
    setLanguageState(next)
    window.localStorage.setItem(STORAGE_KEY, next)
    setDocumentLanguage(next)
  }, [])

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (!isLanguage(saved)) return
    window.setTimeout(() => setLanguageState(saved), 0)
  }, [])

  useEffect(() => {
    setDocumentLanguage(language)
  }, [language])

  const value = useMemo<LanguageContextValue>(() => ({
    language,
    setLanguage,
    t: messages[language],
  }), [language, setLanguage])

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}

export function useI18n() {
  const context = useContext(LanguageContext)
  if (!context) {
    throw new Error("useI18n must be used inside LanguageProvider")
  }
  return context
}

export function useText() {
  const { language } = useI18n()
  return useCallback((en: string, _unused?: string, km?: string) => (
    language === "km" && km ? km : en
  ), [language])
}

export type Text = ReturnType<typeof useText>
