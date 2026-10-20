/** M0 只定义最小 slot 集合；M0-B 再扩展为 React 渲染器。 */
export interface SlotMap {
  "sidebar.section": { id: string; title: string }
  "sidebar.footer.action": { id: string; label: string }
  "settings.section": { id: string; title: string }
  "status.bar": { id: string; text: string }
}
