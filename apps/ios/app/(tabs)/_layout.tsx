import { Tabs } from 'expo-router';
import { TAB_SPECS } from '../../src/app/tabs';
import { SFSymbol } from '../../src/ui/sf-symbol';
import { colorToken } from '../../src/ui/tokens';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: true,
        tabBarActiveTintColor: String(colorToken('accent')),
        tabBarInactiveTintColor: String(colorToken('textSecondary')),
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
