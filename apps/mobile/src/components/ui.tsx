import { useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type KeyboardTypeOptions, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { badgeFor, type OwnershipEntry } from "@/lib/ownership";
import { serif, useTheme } from "@/lib/theme";

/** A scrolling page, centred and capped at phone width on big screens. */
export function Page({ children, bottomInset = 24, testID }: { children: ReactNode; bottomInset?: number; testID?: string }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.paper }} contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom + bottomInset, alignItems: "center" }} testID={testID}>
      <View style={{ width: "100%", maxWidth: 560, paddingHorizontal: 16, gap: 20 }}>{children}</View>
    </ScrollView>
  );
}

export function H1({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  return <Text style={[serif, { fontSize: 28, lineHeight: 34, fontWeight: "600", color: t.ink }, style]} accessibilityRole="header">{children}</Text>;
}

export function H2({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <Text style={[serif, { fontSize: 21, fontWeight: "600", color: t.ink, marginBottom: 8 }]} accessibilityRole="header">{children}</Text>;
}

export function P({ children, muted, small, bold, style, numberOfLines, testID }: { children: ReactNode; muted?: boolean | 2 | 3; small?: boolean; bold?: boolean; style?: StyleProp<TextStyle>; numberOfLines?: number; testID?: string }) {
  const t = useTheme();
  const color = muted === 3 ? t.ink3 : muted ? t.ink2 : t.ink;
  return (
    <Text numberOfLines={numberOfLines} testID={testID} style={[{ color, fontSize: small ? 13 : 16, lineHeight: small ? 18 : 23, fontWeight: bold ? "600" : "400" }, style]}>
      {children}
    </Text>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <Text style={{ color: t.ink3, fontSize: 11, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase" }}>{children}</Text>;
}

export function Card({ children, style, dashed }: { children: ReactNode; style?: StyleProp<ViewStyle>; dashed?: boolean }) {
  const t = useTheme();
  return <View style={[{ backgroundColor: t.surface, borderColor: t.rule, borderWidth: 1, borderRadius: 18, borderStyle: dashed ? "dashed" : "solid" }, style]}>{children}</View>;
}

type Variant = "primary" | "secondary" | "ghost" | "danger";
export function Button({ title, onPress, variant = "primary", disabled, testID, icon }: { title: string; onPress: () => void; variant?: Variant; disabled?: boolean; testID?: string; icon?: string }) {
  const t = useTheme();
  const bg = variant === "primary" ? t.oxblood : variant === "danger" ? t.oxblood : variant === "secondary" ? t.surface : "transparent";
  const fg = variant === "primary" || variant === "danger" ? t.onOxblood : t.ink;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      style={({ pressed }) => ({
        minHeight: 50,
        borderRadius: 14,
        paddingHorizontal: 20,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "row",
        gap: 8,
        backgroundColor: bg,
        borderWidth: variant === "secondary" ? 1 : 0,
        borderColor: t.rule,
        opacity: disabled ? 0.45 : pressed ? 0.85 : 1,
      })}
    >
      {icon && <Text style={{ fontSize: 18 }}>{icon}</Text>}
      <Text style={{ color: fg, fontSize: 16, fontWeight: "600", textDecorationLine: variant === "ghost" ? "underline" : "none" }}>{title}</Text>
    </Pressable>
  );
}

export function LinkText({ children, onPress, testID }: { children: ReactNode; onPress: () => void; testID?: string }) {
  const t = useTheme();
  return (
    <Text onPress={onPress} testID={testID} accessibilityRole="link" style={{ color: t.stamp, fontWeight: "600", textDecorationLine: "underline" }}>
      {children}
    </Text>
  );
}

export function Row({ children, onPress, testID, style }: { children: ReactNode; onPress?: () => void; testID?: string; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const base: ViewStyle = { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12 };
  if (!onPress) return <View style={[base, style]} testID={testID}>{children}</View>;
  return (
    <Pressable onPress={onPress} testID={testID} accessibilityRole="button" style={({ pressed }) => [base, { backgroundColor: pressed ? t.sunk : "transparent" }, style]}>
      {children}
    </Pressable>
  );
}

export function Divider() {
  const t = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.rule }} />;
}

export function Spinner({ label }: { label: string }) {
  const t = useTheme();
  return (
    <View style={{ alignItems: "center", gap: 12, padding: 24 }}>
      <ActivityIndicator color={t.oxblood} />
      <P muted>{label}</P>
    </View>
  );
}

export function ProgressBar({ value }: { value: number }) {
  const t = useTheme();
  return (
    <View style={{ height: 8, borderRadius: 4, backgroundColor: t.sunk }} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}>
      <View style={{ height: 8, borderRadius: 4, backgroundColor: t.oxblood, width: `${Math.round(value * 100)}%` }} />
    </View>
  );
}

export function Notice({ children, tone = "teal" }: { children: ReactNode; tone?: "teal" | "ink" }) {
  const t = useTheme();
  const c = tone === "teal" ? t.teal : t.ink2;
  return (
    <View style={{ borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: tone === "teal" ? `${t.teal}1f` : t.sunk }} accessibilityRole="alert">
      <Text style={{ color: c, fontWeight: "600", fontSize: 14 }}>{children}</Text>
    </View>
  );
}

/** Checked / Matched / Unverified — how sure we are of an ownership chain. */
export function TierBadge({ tier }: { tier: OwnershipEntry["tier"] }) {
  const t = useTheme();
  const b = badgeFor(tier);
  const checked = b.label === "Checked";
  const unverified = b.label === "Unverified";
  return (
    <View
      accessibilityLabel={`${b.label}: ${b.description}`}
      style={{
        alignSelf: "flex-start",
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 2,
        backgroundColor: checked ? `${t.stamp}1a` : "transparent",
        borderWidth: checked ? 0 : 1,
        borderStyle: unverified ? "dashed" : "solid",
        borderColor: t.ink3,
      }}
    >
      <Text style={{ fontSize: 11, fontWeight: "600", color: checked ? t.stamp : unverified ? t.ink3 : t.ink2, fontStyle: unverified ? "italic" : "normal" }}>
        {checked ? "✓ " : ""}
        {b.label}
      </Text>
    </View>
  );
}

/** For rows without a named owner: "Estimated" (from where it was paid) or "You set this" (the user's own fix). */
export function BasisBadge({ basis }: { basis: "estimated" | "you" }) {
  const t = useTheme();
  const label = basis === "you" ? "You set this" : "Estimated";
  const description = basis === "you" ? "You chose this country." : "We don't know the owner, so this is counted under the country it was paid in.";
  return (
    <View accessibilityLabel={`${label}: ${description}`} style={{ alignSelf: "flex-start", borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, borderWidth: 1, borderStyle: "dotted", borderColor: basis === "you" ? t.teal : t.ink3 }}>
      <Text style={{ fontSize: 11, fontWeight: "600", color: basis === "you" ? t.teal : t.ink3 }}>{label}</Text>
    </View>
  );
}

export function Chip({ label, active, onPress, testID }: { label: string; active?: boolean; onPress: () => void; testID?: string }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      style={{ borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: active ? t.ink : "transparent", borderWidth: 1, borderColor: active ? t.ink : t.rule }}
    >
      <Text style={{ fontSize: 12, fontWeight: "600", color: active ? t.paper : t.ink2 }}>{label}</Text>
    </Pressable>
  );
}

/** A collapsed section that opens on tap. */
export function Disclosure({ title, right, children, defaultOpen, testID }: { title: ReactNode; right?: ReactNode; children: ReactNode; defaultOpen?: boolean; testID?: string }) {
  const t = useTheme();
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <Card>
      <Pressable onPress={() => setOpen((o) => !o)} accessibilityRole="button" accessibilityState={{ expanded: open }} testID={testID} style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 16 }}>
        <View style={{ flex: 1 }}>{title}</View>
        {right}
        <Text style={{ color: t.ink3, transform: [{ rotate: open ? "180deg" : "0deg" }] }}>⌄</Text>
      </Pressable>
      {open && (
        <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.rule, padding: 16, gap: 12 }}>{children}</View>
      )}
    </Card>
  );
}

export function BackLink({ label = "‹ Back", onPress }: { label?: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="link" hitSlop={10} style={{ alignSelf: "flex-start" }}>
      <Text style={{ color: t.ink2, fontSize: 15 }}>{label}</Text>
    </Pressable>
  );
}

/** A text field with a visible label. */
export function Field({ label, value, onChange, placeholder, secure, keyboard, autoComplete, editable = true, testID, maxLength }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; secure?: boolean; keyboard?: KeyboardTypeOptions;
  autoComplete?: "email" | "one-time-code" | "new-password" | "current-password" | "off"; editable?: boolean; testID?: string; maxLength?: number;
}) {
  const t = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontSize: 13, fontWeight: "600", color: t.ink2 }}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={t.ink3}
        secureTextEntry={secure}
        keyboardType={keyboard}
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect={false}
        editable={editable}
        maxLength={maxLength}
        accessibilityLabel={label}
        testID={testID}
        style={{ minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: t.rule, backgroundColor: editable ? t.surface : t.sunk, paddingHorizontal: 12, color: t.ink, fontSize: 16 }}
      />
    </View>
  );
}

/** A tick box with its label; unticked unless the person ticks it. */
export function Checkbox({ checked, onChange, children, testID }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; testID?: string }) {
  const t = useTheme();
  return (
    <Pressable onPress={() => onChange(!checked)} accessibilityRole="checkbox" accessibilityState={{ checked }} testID={testID} style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
      <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: checked ? t.oxblood : t.ink3, backgroundColor: checked ? t.oxblood : "transparent", alignItems: "center", justifyContent: "center", marginTop: 1 }}>
        {checked && <Text style={{ color: t.onOxblood, fontSize: 14, fontWeight: "700", lineHeight: 16 }}>✓</Text>}
      </View>
      <View style={{ flex: 1 }}>{children}</View>
    </Pressable>
  );
}
