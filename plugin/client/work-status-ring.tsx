/*!
 * SPDX-License-Identifier: Apache-2.0
 * https://www.apache.org/licenses/LICENSE-2.0
 * Adapted from Paseo 0.11.4 components/status-ring/{geometry,frame,index,clock.web}.
 * Copyright (c) 2025-present Mohamed Boudra. Apache-2.0; see PASEO-LICENSE.
 * Changes: public plugin theme adapter, configurable attention color, and React Native
 * Animated in place of Paseo's private Reanimated clock. Web uses the same timeline.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, View } from "react-native";

const PERIOD = 900;
const circle = { width: 12, height: 12, borderRadius: 999, borderWidth: 1.5 };

export function WorkStatusRing({ attention, foreground, platform }: {
  attention: boolean;
  foreground: string;
  platform: string;
}) {
  // The SDK omits Paseo's statusDot* tokens. Match its light/dark status-dot palettes.
  const hex = foreground.replace(/^#/, "");
  const normalized = hex.length === 3 ? hex.split("").map(c => c + c).join("") : hex;
  const rgb = /^[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized, 16) : 0xffffff;
  const dark = ((rgb >> 16) * 0.2126 + ((rgb >> 8) & 255) * 0.7152 + (rgb & 255) * 0.0722) > 128;
  const color = attention ? dark ? "#db932e" : "#b37824" : dark ? "#5caaf6" : "#268ae0";
  const arc = useRef<any>(null);
  const rotation = useRef(new Animated.Value(0)).current;
  const [reducedMotion, setReducedMotion] = useState(true);

  useEffect(() => {
    let alive = true;
    const update = (value: boolean) => { if (alive) setReducedMotion(value); };
    void AccessibilityInfo.isReduceMotionEnabled().then(update, () => update(false));
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", update);
    return () => { alive = false; subscription.remove(); };
  }, []);

  useLayoutEffect(() => {
    if (platform !== "web" || reducedMotion || !arc.current?.animate) return;
    const animation = arc.current.animate({ transform: ["rotate(0deg)", "rotate(360deg)"] },
      { duration: PERIOD, easing: "linear", iterations: Infinity });
    animation.startTime = 0;
    return () => animation.cancel();
  }, [platform, reducedMotion]);

  useEffect(() => {
    if (platform === "web" || reducedMotion) return;
    let disposed = false;
    let loop: ReturnType<typeof Animated.loop> | undefined;
    const phase = (Date.now() % PERIOD) / PERIOD;
    rotation.setValue(phase);
    const first = Animated.timing(rotation, { toValue: 1, duration: (1 - phase) * PERIOD, easing: Easing.linear, useNativeDriver: true, isInteraction: false });
    first.start(({ finished }) => {
      if (!finished || disposed) return;
      rotation.setValue(0);
      loop = Animated.loop(Animated.timing(rotation, { toValue: 1, duration: PERIOD, easing: Easing.linear, useNativeDriver: true, isInteraction: false }));
      loop.start();
    });
    return () => { disposed = true; first.stop(); loop?.stop(); };
  }, [platform, reducedMotion, rotation]);

  const head = <View style={{ ...circle, borderColor: "transparent", borderTopColor: color, opacity: 0.9 }} />;
  const rotatorStyle = { position: "absolute" as const, width: 12, height: 12 };
  const animatedStyle = { ...rotatorStyle, transform: [{ rotate: rotation.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }] };
  return <View style={{ width: 14, height: 14, borderRadius: 999, alignItems: "center", justifyContent: "center" }}>
    <View style={{ ...circle, position: "absolute", borderColor: color, opacity: 0.3 }} />
    {platform === "web"
      ? <View ref={arc} style={rotatorStyle}>{head}</View>
      : <Animated.View style={animatedStyle}>{head}</Animated.View>}
    <View style={{ width: 6, height: 6, borderRadius: 999, backgroundColor: color }} />
  </View>;
}
