import { Tabs } from 'expo-router';
import { TAB_SPECS } from '../../src/app/tabs';
import { SFSymbol } from '../../src/ui/sf-symbol';
import { colorToken } from '../../src/ui/tokens';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        /*
         * The native bar carries the title. The tab screens used to draw the
         * same words again underneath it, so every tab read "Receipts
         * Receipts".
         *
         * Tab options live here alone. The tab routes set them again through
         * `Stack.Screen`, which is the wrong component inside a `Tabs` layout
         * and is how the two came to disagree in the first place.
         */
        headerShown: true,
        /*
         * Cast, not stringified. These are typed `string` by React Navigation
         * but a `PlatformColor` reaches the style layer intact and adapts to
         * the system appearance; `String(...)` produced "[object Object]",
         * which is not a colour, so the selected and unselected tints both
         * fell back to a default and the labels went unreadable in dark mode.
         */
        tabBarActiveTintColor: colorToken('accent') as string,
        tabBarInactiveTintColor: colorToken('textSecondary') as string,
        tabBarAccessibilityLabel: 'Primary navigation tabs',
      }}
    >
      {TAB_SPECS.map((tab) => (
        <Tabs.Screen
          key={tab.routeName}
          name={tab.routeName}
          options={{
            title: tab.title,
            tabBarAccessibilityLabel: `${tab.title} tab`,
            tabBarIcon: ({ color, size }) => (
              <SFSymbol
                name={tab.symbolName}
                fallbackText={tab.symbolFallback}
                color={color}
                size={size}
                accessibilityLabel={`${tab.title} symbol`}
              />
            ),
          }}
        />
      ))}
    </Tabs>
  );
}
