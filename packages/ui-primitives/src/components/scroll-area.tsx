/** 基于 Base UI ScrollArea 的滚动区域组合。 */
import { ScrollArea as BaseScrollArea } from "@base-ui/react/scroll-area"

export const ScrollArea = {
  Root: BaseScrollArea.Root,
  Viewport: BaseScrollArea.Viewport,
  Scrollbar: BaseScrollArea.Scrollbar,
  Thumb: BaseScrollArea.Thumb,
  Corner: BaseScrollArea.Corner,
}
