// 负责窗口底部的短提示，让还没接入内核的操作也有可见反馈。
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react"
import { Icon } from "./icon"

type Toast = { id: number; text: string; icon: string }

type ShowToast = (text: string, icon?: string) => void

const ToastContext = createContext<ShowToast>(() => undefined)

/** 提供 useToast；同时最多显示三条，每条 2.4 秒后消失。 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(0)
  const show = useCallback<ShowToast>((text, icon = "check") => {
    nextId.current += 1
    const id = nextId.current
    setToasts((current) => [...current.slice(-2), { id, text, icon }])
    window.setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 2400)
  }, [])
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className="toast">
            <Icon name={toast.icon} small />
            {toast.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

/** 返回显示短提示的函数；在 ToastProvider 之外调用时什么也不做。 */
export function useToast(): ShowToast {
  return useContext(ToastContext)
}
