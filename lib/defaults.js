// Starting list: monthly wholesale ration for 3 people. qty is in g, ml or pcs for
// settings.basePeople; `text` is a fixed label that doesn't scale.

const CATEGORIES = [
  ["staples", "Staples & grains", "monthly"],
  ["dals", "Dals & pulses", "monthly"],
  ["basics", "Oil, ghee & basics", "monthly"],
  ["powders", "Powdered masalas", "monthly"],
  ["whole", "Whole spices", "monthly"],
  ["extras", "Extras & household", "monthly"],
  ["fresh", "Weekly fresh", "weekly"],
];

const ITEMS = [
  ["atta", "staples", "Atta (whole wheat)", 12000],
  ["rice", "staples", "Rice (Sona Masoori)", 8000],
  ["poha", "staples", "Poha (thick)", 6000],
  ["rava", "staples", "Rava / sooji", 1000],
  ["besan", "staples", "Besan", 500],
  ["maida", "staples", "Maida", 500],
  ["semiya", "staples", "Vermicelli (semiya)", 500],
  ["oats", "staples", "Oats or cornflakes", 500, { note: "optional" }],

  ["toor", "dals", "Toor dal", 2000],
  ["moong", "dals", "Moong dal (yellow)", 1000],
  ["chana", "dals", "Chana dal", 500],
  ["masoor", "dals", "Masoor dal", 500],
  ["urad", "dals", "Urad dal", 500, { note: "tadka / dosa" }],
  ["rajma", "dals", "Rajma or chole", 1000],
  ["gmoong", "dals", "Green moong (whole)", 500],

  ["oil", "basics", "Cooking oil", 3000, { unit: "ml", note: "sunflower or groundnut" }],
  ["ghee", "basics", "Ghee", 500],
  ["sugar", "basics", "Sugar", 3000],
  ["salt", "basics", "Salt (iodized)", 1000],
  ["jaggery", "basics", "Jaggery", 500],
  ["tea", "basics", "Tea powder", 500],
  ["peanuts", "basics", "Peanuts", 500, { note: "for poha" }],
  ["tamarind", "basics", "Tamarind", 250],
  ["coffee", "basics", "Coffee", 200, { note: "only if you drink it" }],

  ["turmeric", "powders", "Turmeric powder", 200],
  ["chilli", "powders", "Red chilli powder", 500],
  ["dhaniya", "powders", "Coriander powder", 500],
  ["jeerap", "powders", "Jeera powder", 100],
  ["garam", "powders", "Garam masala", 100],
  ["chicken_masala", "powders", "Chicken masala", 200],
  ["sambar", "powders", "Sambar powder", 200],
  ["rasam", "powders", "Rasam powder", 100],
  ["pepperp", "powders", "Black pepper powder", 50],
  ["chaat", "powders", "Chaat masala", 50],
  ["hing", "powders", "Hing (asafoetida)", 25],
  ["kasuri", "powders", "Kasuri methi", 25],

  ["jeera", "whole", "Jeera (cumin)", 250],
  ["mustard", "whole", "Mustard seeds", 250],
  ["dhaniya_seeds", "whole", "Coriander seeds", 200],
  ["drychilli", "whole", "Dry red chillies", 250],
  ["methi", "whole", "Methi seeds", 100],
  ["saunf", "whole", "Saunf (fennel)", 100],
  ["ajwain", "whole", "Ajwain", 50],
  ["pepper", "whole", "Black pepper", 50],
  ["cloves", "whole", "Cloves", null, { text: "25–50 g" }],
  ["cardamom", "whole", "Cardamom", null, { text: "25–50 g" }],
  ["cinnamon", "whole", "Cinnamon", null, { text: "25–50 g" }],
  ["bayleaf", "whole", "Bay leaf", null, { text: "25–50 g" }],

  ["pickle", "extras", "Pickle", null],
  ["papad", "extras", "Papad", null],
  ["biscuits", "extras", "Biscuits or rusk", null, { note: "for tea" }],
  ["bread", "extras", "Bread and butter", null],
  ["soda", "extras", "Baking soda and Eno", null],
  ["dishwash", "extras", "Dishwash", null],
  ["detergent", "extras", "Detergent", null],
  ["toilet", "extras", "Toilet items", null],

  ["milk", "fresh", "Milk", null],
  ["veg", "fresh", "Vegetables", null],
  ["chicken", "fresh", "Chicken", null],
  ["eggs", "fresh", "Eggs", null],
  ["ginger", "fresh", "Ginger", null],
  ["garlic", "fresh", "Garlic", null],
  ["greenchilli", "fresh", "Green chillies", null],
  ["curryleaves", "fresh", "Curry leaves", null],
  ["coriander", "fresh", "Coriander leaves", null],
  ["coconut", "fresh", "Coconut", null],
];

export function defaultData() {
  const categories = {};
  CATEGORIES.forEach(([id, title, freq], order) => (categories[id] = { title, freq, order }));
  const items = {};
  ITEMS.forEach(([id, cat, name, qty, extra = {}], order) => {
    const item = { name, cat, order };
    if (qty != null) { item.qty = qty; item.unit = extra.unit || "g"; }
    if (extra.text) item.text = extra.text;
    if (extra.note) item.note = extra.note;
    items[id] = item;
  });
  return {
    version: 1,
    rev: 1,
    settings: {
      startMonth: "2026-10", // first month shown; earlier months are hidden
      people: 3,
      basePeople: 3,
      monthlyDay: 1,
      weeklyDay: 0,
      reminderTime: "10:00",
      budgetLow: 5500,
      budgetHigh: 7000,
    },
    categories,
    items,
    months: {},
    weeks: {},
  };
}

// Minimal shape check for imports and for data read back from storage.
export function looksLikeData(d) {
  return !!d && typeof d === "object" && !Array.isArray(d)
    && ["settings", "categories", "items", "months"].every((k) => d[k] && typeof d[k] === "object" && !Array.isArray(d[k]));
}
