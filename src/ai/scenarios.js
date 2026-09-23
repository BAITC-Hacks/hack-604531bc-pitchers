const base = { city: "Алматы", date: "2026-10-17", eventType: "корпоратив", category: "Ведущий", budget: 1500000 };

export const DEMO_SCENARIOS = [
  { title: "Плотная категория", query: base, status: "found", count: 3 },
  { title: "Та же категория в декабре", query: { ...base, date: "2026-12-26" }, status: "partial", count: 1 },
  { title: "Редкая категория", query: { ...base, category: "Флорист", eventType: "свадьба", budget: 500000 }, status: "partial", count: 1 },
  { title: "Категории нет в городе", query: { ...base, city: "Астана", category: "Декоратор" }, status: "no_category", count: 0 },
  { title: "Все отфильтрованы", query: { ...base, date: "2026-12-25", budget: 100000 }, status: "all_filtered", count: 0 },
];
