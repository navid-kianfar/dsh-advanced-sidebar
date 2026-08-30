/**
 * The shadcn-vocabulary component kit this plugin's surfaces are built from.
 *
 * shadcn/ui cannot be installed into an out-of-tree browser half: it is Tailwind utilities over
 * Radix primitives, and this package ships as one bundled CSS-Modules file with no Tailwind
 * pipeline and no second React runtime to give Radix. What is reproduced is the vocabulary — the
 * variant and size axes, the geometry scale, the flat bordered surfaces, and the focus ring — over
 * the harness's own design tokens, so the components sit in the app's themes unmodified.
 *
 * They are also what fixes the menu: every floating surface is placed through the collision
 * handling in {@link module:@achasoft/dsh-advanced-sidebar/client/ui/anchor}, which the harness's
 * `Menu` primitive applies to a root list but not to a submenu.
 * @module @achasoft/dsh-advanced-sidebar/client/ui
 */

export { Alert } from './Alert.tsx'
export type { AlertProps, AlertTone } from './Alert.tsx'
export { Badge } from './Badge.tsx'
export type { BadgeProps, BadgeVariant } from './Badge.tsx'
export { Button } from './Button.tsx'
export type { ButtonProps, ButtonSize, ButtonVariant } from './Button.tsx'
export { Calendar, dayKey, monthGrid, startOfDay } from './Calendar.tsx'
export type { CalendarProps } from './Calendar.tsx'
export { DatePicker } from './DatePicker.tsx'
export type { DatePickerProps } from './DatePicker.tsx'
export { AlertDialog, Dialog } from './Dialog.tsx'
export type { DialogProps } from './Dialog.tsx'
export { DropdownMenu } from './DropdownMenu.tsx'
export type {
  DropdownMenuProps, MenuItemNode, MenuLabelNode, MenuNode, MenuSeparatorNode, MenuSubNode,
} from './DropdownMenu.tsx'
export { Input, Textarea } from './Input.tsx'
export type { InputProps } from './Input.tsx'
export { Layer, insideLayerTree } from './Layer.tsx'
export type { LayerProps } from './Layer.tsx'
export { Select } from './Select.tsx'
export type { SelectOption, SelectProps } from './Select.tsx'
export { Separator } from './Separator.tsx'
export { Tabs } from './Tabs.tsx'
export type { TabDescriptor, TabsProps } from './Tabs.tsx'
export { Checkbox, CheckboxRow, Switch } from './Toggle.tsx'
export type { ToggleProps } from './Toggle.tsx'
export { Tooltip } from './Tooltip.tsx'
export { DEFAULT_PLACEMENT, placeLayer, useAnchoredLayer } from './anchor.ts'
export type { Align, AnchoredLayer, Box, Placement, PlacementRequest, Side } from './anchor.ts'
