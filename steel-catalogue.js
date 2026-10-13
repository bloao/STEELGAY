// Steel product catalogue for the "Add product" picker.
//
// Each family is a kind of product a UK stockholder buys (equal angle, UB,
// plate …) with the standard sizes, grades and lengths it comes in. Picking a
// family + size works out the description, the specification and the 10-digit
// UK commodity code — so the steel quota category follows automatically.
//
// Codes come from the GOV.UK Trade Tariff (chapters 72/73, see
// steel-commodities.js); tests/catalogue.test.mjs checks every code a family
// can produce exists there. Where the tariff splits a product on something a
// size can't tell us (e.g. coating chemistry) the family returns
// { choose: "<prefix>" } and the form asks which tariff line applies.
//
// Loaded in the browser as window.STEEL_CATALOGUE; tests load it with vm.
(function (root) {
  "use strict";

  // ---------------------------------------------------------------- helpers
  const X = "×";
  const dims = (s) => String(s).split(/[×x*]/).map((v) => parseFloat(v));
  const range = (list, fn) => list.map(fn);
  const combos = (a, b, keep = () => true) => a.flatMap((x) => b.filter((y) => keep(x, y)).map((y) => `${x}${X}${y}`));
  const mm = (v) => `${v} mm`;
  const num = (s) => parseFloat(String(s));

  // Carbon matters for bar codes: < 0.25 % C vs 0.25 % or more.
  const BAR_GRADES = [
    { value: "S275JR", carbon: "low" },
    { value: "S355J2", carbon: "low" },
    { value: "S355JR", carbon: "low" },
    { value: "080A15 (mild)", carbon: "low" },
    { value: "EN3B / 070M20", carbon: "low" },
    { value: "EN8 / 080M40", carbon: "high" },
    { value: "EN9 / 070M55", carbon: "high" },
  ];
  const BRIGHT_GRADES = [
    { value: "EN3B / 070M20", carbon: "low" },
    { value: "080A15 (mild)", carbon: "low" },
    { value: "EN1A / 230M07 (free-cutting)", carbon: "free" },
    { value: "EN1A Leaded / 230M07Pb", carbon: "free" },
    { value: "EN8 / 080M40", carbon: "high" },
    { value: "EN9 / 070M55", carbon: "high" },
  ];
  const carbonOf = (grades, v) => (grades.find((g) => g.value === v) || grades[0]).carbon;
  const STRUCT_GRADES = ["S275JR", "S355JR", "S355J0", "S355J2", "S355J2+N"];
  const HOLLOW_GRADES = ["S355J2H (cold formed, EN 10219)", "S355J2H (hot finished, EN 10210)", "S275J0H", "S235JRH"];
  const PLATE_GRADES = ["S275JR", "S275J2", "S355J2+N", "S355K2", "S355ML", "DH36"];
  const SHEET_GRADES = ["DC01", "DD11", "S275JR", "S355MC"];
  const GALV_GRADES = ["DX51D+Z275", "DX51D+Z140", "S250GD+Z275", "S350GD+Z275"];
  const STAINLESS_GRADES = [
    { value: "304 / 1.4301", nickel: "high" },
    { value: "304L / 1.4307", nickel: "high" },
    { value: "316 / 1.4401", nickel: "high" },
    { value: "316L / 1.4404", nickel: "high" },
    { value: "303 / 1.4305", nickel: "high" },
    { value: "430 / 1.4016", nickel: "low" },
  ];
  const nickelOf = (v) => (STAINLESS_GRADES.find((g) => g.value === v) || STAINLESS_GRADES[0]).nickel;

  const BAR_LENGTHS = ["6 m", "7.3 m", "Random lengths", "Cut to size"];
  const ANGLE_LENGTHS = ["6 m", "7.5 m", "Cut to size"];
  const SECTION_LENGTHS = ["6 m", "9 m", "10 m", "12 m", "13.5 m", "15 m", "Cut to size"];
  const HOLLOW_LENGTHS = ["6 m", "7.5 m", "12 m", "Cut to size"];
  const BRIGHT_LENGTHS = ["3 m", "3.66 m", "6 m", "Cut to size"];

  const field = (key, label, values, extra = {}) => ({ key, label, values, ...extra });
  const gradeField = (values) => field("grade", "Grade", values.map((g) => (typeof g === "string" ? g : g.value)));
  const lengthField = (values) => field("length", "Length", values);

  // ---------------------------------------------------------------- sizes
  const EQUAL_ANGLES = [
    "20×20×3", "25×25×3", "25×25×5", "30×30×3", "30×30×5", "40×40×3", "40×40×4", "40×40×5", "40×40×6",
    "45×45×5", "50×50×4", "50×50×5", "50×50×6", "50×50×8", "60×60×5", "60×60×6", "60×60×8", "60×60×10",
    "65×65×6", "70×70×6", "70×70×8", "70×70×10", "75×75×6", "75×75×8", "80×80×6", "80×80×8", "80×80×10",
    "90×90×6", "90×90×7", "90×90×8", "90×90×10", "100×100×8", "100×100×10", "100×100×12", "100×100×15",
    "120×120×8", "120×120×10", "120×120×12", "120×120×15", "150×150×10", "150×150×12", "150×150×15",
    "150×150×18", "200×200×16", "200×200×18", "200×200×20", "200×200×24",
  ];
  const UNEQUAL_ANGLES = [
    "30×20×3", "40×20×3", "40×25×4", "45×30×4", "50×30×5", "50×40×5", "60×30×5", "60×30×6", "60×40×5",
    "60×40×6", "65×50×5", "65×50×6", "65×50×8", "75×50×6", "75×50×8", "80×40×6", "80×40×8", "80×60×7",
    "100×50×6", "100×50×8", "100×65×7", "100×65×8", "100×65×10", "100×75×8", "100×75×10", "100×75×12",
    "125×75×8", "125×75×10", "125×75×12", "150×75×10", "150×75×12", "150×75×15", "150×90×10", "150×90×12",
    "150×90×15", "200×100×10", "200×100×12", "200×100×15", "200×150×12", "200×150×15",
  ];
  const FLAT_WIDTHS = [10, 12, 16, 20, 25, 30, 35, 40, 45, 50, 60, 65, 70, 75, 80, 90, 100, 110, 120, 130, 140, 150];
  const FLAT_THICK = [3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50];
  const FLATS = combos(FLAT_WIDTHS, FLAT_THICK, (w, t) => t < w);
  const WIDE_FLATS = combos([160, 180, 200, 220, 250, 300, 350, 400, 450, 500], [6, 8, 10, 12, 15, 20, 25, 30, 40, 50]);
  const ROUNDS = [6, 8, 10, 12, 16, 20, 25, 30, 32, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 90, 100, 110, 120, 130, 150, 175, 200, 250, 300];
  const SQUARES = [6, 8, 10, 12, 16, 20, 25, 30, 32, 40, 50, 60, 65, 75, 80, 100];
  const HEXES = [10, 13, 17, 19, 22, 24, 27, 30, 32, 36, 41, 46, 50, 55, 60];
  const TEES = ["20×20×3", "25×25×3", "30×30×4", "35×35×4", "40×40×5", "50×50×6", "60×60×7", "70×70×8", "80×80×9", "100×100×11", "120×120×13"];
  const CHANNELS = ["30×15", "40×20", "50×25", "50×38", "60×30", "65×42", "76×38"];
  const UB = [
    "127×76×13", "152×89×16", "178×102×19", "203×102×23", "203×133×25", "203×133×30", "254×102×22",
    "254×102×25", "254×102×28", "254×146×31", "254×146×37", "254×146×43", "305×102×25", "305×102×28",
    "305×102×33", "305×127×37", "305×127×42", "305×127×48", "305×165×40", "305×165×46", "305×165×54",
    "356×127×33", "356×127×39", "356×171×45", "356×171×51", "356×171×57", "356×171×67", "406×140×39",
    "406×140×46", "406×178×54", "406×178×60", "406×178×67", "406×178×74", "457×152×52", "457×152×60",
    "457×152×67", "457×152×74", "457×152×82", "457×191×67", "457×191×74", "457×191×82", "457×191×89",
    "457×191×98", "533×210×82", "533×210×92", "533×210×101", "533×210×109", "533×210×122", "610×229×101",
    "610×229×113", "610×229×125", "610×229×140", "610×305×149", "610×305×179", "686×254×125", "686×254×140",
    "762×267×134", "762×267×147", "838×292×176", "914×305×201", "914×305×224",
  ];
  const UC = [
    "152×152×23", "152×152×30", "152×152×37", "152×152×44", "152×152×51", "203×203×46", "203×203×52",
    "203×203×60", "203×203×71", "203×203×86", "254×254×73", "254×254×89", "254×254×107", "254×254×132",
    "254×254×167", "305×305×97", "305×305×118", "305×305×137", "305×305×158", "305×305×198", "305×305×240",
    "305×305×283", "356×368×129", "356×368×153", "356×368×177", "356×368×202",
  ];
  const PFC = [
    "100×50×10", "125×65×15", "150×75×18", "150×90×24", "180×75×20", "180×90×26", "200×75×23", "200×90×30",
    "230×75×26", "230×90×32", "260×75×28", "260×90×35", "300×90×41", "300×100×46", "380×100×54", "430×100×64",
  ];
  const RSJ = ["76×76×13", "102×44×7", "102×64×9", "127×76×13", "127×114×27", "152×127×37", "203×152×52", "254×114×37", "254×203×82"];
  const SHS = [
    "20×20×2", "25×25×2", "25×25×2.5", "25×25×3", "30×30×2", "30×30×2.5", "30×30×3", "40×40×2", "40×40×2.5",
    "40×40×3", "40×40×4", "50×50×2.5", "50×50×3", "50×50×4", "50×50×5", "60×60×3", "60×60×4", "60×60×5",
    "70×70×4", "70×70×5", "80×80×3", "80×80×4", "80×80×5", "80×80×6", "90×90×4", "90×90×5", "100×100×4",
    "100×100×5", "100×100×6", "100×100×8", "100×100×10", "120×120×5", "120×120×6", "120×120×8", "120×120×10",
    "140×140×6", "140×140×8", "150×150×5", "150×150×6", "150×150×8", "150×150×10", "150×150×12.5",
    "180×180×8", "180×180×10", "200×200×6", "200×200×8", "200×200×10", "200×200×12.5", "250×250×8",
    "250×250×10", "250×250×12.5", "300×300×10", "300×300×12.5",
  ];
  const RHS = [
    "40×20×2", "40×20×2.5", "50×25×2", "50×25×2.5", "50×25×3", "50×30×3", "60×30×3", "60×40×3", "60×40×4",
    "70×50×3", "80×40×3", "80×40×4", "80×60×4", "90×50×4", "100×40×4", "100×50×3", "100×50×4", "100×50×5",
    "100×50×6", "100×60×4", "100×60×5", "120×60×4", "120×60×5", "120×60×6", "120×80×5", "120×80×6",
    "150×50×5", "150×100×5", "150×100×6", "150×100×8", "160×80×5", "160×80×6", "200×100×5", "200×100×6",
    "200×100×8", "200×100×10", "250×150×6", "250×150×8", "250×150×10", "300×200×8", "300×200×10", "300×200×12.5",
  ];
  const CHS = [
    "21.3×2.6", "26.9×3.2", "33.7×2.6", "33.7×3.2", "42.4×2.6", "42.4×3.2", "48.3×3.2", "48.3×4", "60.3×3.2",
    "60.3×4", "76.1×3.2", "76.1×4", "88.9×3.2", "88.9×4", "88.9×5", "114.3×3.6", "114.3×5", "114.3×6.3",
    "139.7×5", "139.7×6.3", "168.3×5", "168.3×6.3", "168.3×8", "193.7×6.3", "193.7×8", "219.1×6.3",
    "219.1×8", "219.1×10", "273×6.3", "273×8", "273×10", "323.9×8", "323.9×10", "355.6×8", "355.6×10",
    "406.4×10", "406.4×12.5",
  ];
  const PLATE_THICK = [3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 100];
  const PLATE_SIZES = ["2000×1000", "2500×1250", "3000×1500", "4000×2000", "6000×1500", "6000×2000", "6000×2500", "8000×2500", "10000×2500", "12000×2500", "6000×3000"];
  const SHEET_SIZES = ["2000×1000", "2500×1250", "3000×1500", "Coil", "Slit coil"];
  const SHEET_THICK_HR = [1.5, 2, 2.5, 3, 4];
  const SHEET_THICK_CR = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.2, 1.5, 2, 2.5, 3];
  const SHEET_THICK_GALV = [0.4, 0.5, 0.55, 0.6, 0.7, 0.8, 0.9, 1, 1.2, 1.5, 2, 2.5, 3];
  const CHEQUER_THICK = [2.5, 3, 4.5, 6, 8, 10];
  const REBAR = [6, 8, 10, 12, 16, 20, 25, 32, 40];
  const WIRE_ROD = [5.5, 6, 6.5, 7, 8, 9, 10, 12, 14, 16];
  const WIRE = [0.5, 0.7, 0.9, 1, 1.25, 1.6, 2, 2.5, 3, 3.15, 4, 5, 6];

  // ---------------------------------------------------------------- families
  // fields[0] is the size — the search index pairs it with the family name.
  const families = [
    // ---- merchant bar & light sections (quota category 12B)
    {
      id: "equal-angle", label: "Equal angle", group: "Merchant Bar", short: "Equal Angle",
      keywords: "angle l section ea angle iron",
      fields: [field("size", "Size (mm)", EQUAL_ANGLES), gradeField(STRUCT_GRADES), lengthField(ANGLE_LENGTHS)],
      code: (s) => (Math.max(...dims(s.size).slice(0, 2)) < 80 ? "7216210000" : "7216401000"),
      name: (s) => `${s.size} Equal Angle`,
    },
    {
      id: "unequal-angle", label: "Unequal angle", group: "Merchant Bar", short: "Unequal Angle",
      keywords: "angle l section ua angle iron",
      fields: [field("size", "Size (mm)", UNEQUAL_ANGLES), gradeField(STRUCT_GRADES), lengthField(ANGLE_LENGTHS)],
      code: (s) => (Math.max(...dims(s.size).slice(0, 2)) < 80 ? "7216210000" : "7216401000"),
      name: (s) => `${s.size} Unequal Angle`,
    },
    {
      id: "flat-bar", label: "Flat bar", group: "Merchant Bar",
      keywords: "flat flats strip bar hot rolled",
      fields: [field("size", "Width × thickness (mm)", FLATS), gradeField(BAR_GRADES), lengthField(BAR_LENGTHS)],
      code: (s) => (carbonOf(BAR_GRADES, s.grade) === "high" ? "7214919090" : "7214911090"),
      name: (s) => `${s.size} Flat`,
    },
    {
      id: "round-bar", label: "Round bar", group: "Merchant Bar",
      keywords: "round rod bar hot rolled black bar",
      fields: [field("size", "Diameter", ROUNDS.map(mm)), gradeField(BAR_GRADES), lengthField(BAR_LENGTHS)],
      code: (s) => {
        const big = num(s.size) >= 80;
        return carbonOf(BAR_GRADES, s.grade) === "high" ? (big ? "7214997100" : "7214997900") : (big ? "7214993100" : "7214993900");
      },
      name: (s) => `${s.size} Round`,
    },
    {
      id: "square-bar", label: "Square bar", group: "Merchant Bar",
      keywords: "square bar hot rolled",
      fields: [field("size", "Size", SQUARES.map(mm)), gradeField(BAR_GRADES), lengthField(BAR_LENGTHS)],
      code: (s) => (carbonOf(BAR_GRADES, s.grade) === "high" ? "7214999590" : "7214995000"),
      name: (s) => `${s.size} Square`,
    },
    {
      id: "hex-bar", label: "Hexagon bar", group: "Merchant Bar",
      keywords: "hex hexagon bar a/f",
      fields: [field("size", "Across flats", HEXES.map(mm)), gradeField(BAR_GRADES), lengthField(BAR_LENGTHS)],
      code: (s) => (carbonOf(BAR_GRADES, s.grade) === "high" ? "7214999590" : "7214995000"),
      name: (s) => `${s.size} Hex`,
    },
    {
      id: "tee", label: "Tee section", group: "Merchant Bar", short: "Tee",
      keywords: "tee t section t bar",
      fields: [field("size", "Size (mm)", TEES), gradeField(STRUCT_GRADES), lengthField(ANGLE_LENGTHS)],
      code: (s) => (dims(s.size)[1] < 80 ? "7216220000" : "7216409000"),
      name: (s) => `${s.size} Tee`,
    },
    {
      id: "channel", label: "Channel (under 80 mm)", group: "Merchant Bar",
      keywords: "channel u section small channel",
      fields: [field("size", "Size (mm)", CHANNELS), gradeField(STRUCT_GRADES), lengthField(ANGLE_LENGTHS)],
      code: () => "7216100000",
      name: (s) => `${s.size} Channel`,
    },

    // ---- structural sections (quota category 17)
    {
      id: "ub", label: "Universal beam (UB)", group: "Structural Sections",
      keywords: "ub universal beam i beam joist steel beam",
      fields: [field("size", "Serial size × kg/m", UB), gradeField(STRUCT_GRADES), lengthField(SECTION_LENGTHS)],
      code: (s) => (dims(s.size)[0] <= 220 ? "7216321100" : "7216329100"),
      name: (s) => `${s.size} UB`,
    },
    {
      id: "uc", label: "Universal column (UC)", group: "Structural Sections",
      keywords: "uc universal column h beam h section",
      fields: [field("size", "Serial size × kg/m", UC), gradeField(STRUCT_GRADES), lengthField(SECTION_LENGTHS)],
      code: (s) => (dims(s.size)[0] <= 180 ? "7216331000" : "7216339000"),
      name: (s) => `${s.size} UC`,
    },
    {
      id: "pfc", label: "Parallel flange channel (PFC)", group: "Structural Sections",
      keywords: "pfc channel u section parallel flange",
      fields: [field("size", "Size × kg/m", PFC), gradeField(STRUCT_GRADES), lengthField(SECTION_LENGTHS)],
      code: (s) => (dims(s.size)[0] <= 220 ? "7216311000" : "7216319000"),
      name: (s) => `${s.size} PFC`,
    },
    {
      id: "rsj", label: "Joist (RSJ, taper flange)", group: "Structural Sections",
      keywords: "rsj joist taper flange i beam",
      fields: [field("size", "Size × kg/m", RSJ), gradeField(STRUCT_GRADES), lengthField(SECTION_LENGTHS)],
      code: (s) => {
        const h = dims(s.size)[0];
        return h < 80 ? "7216100000" : h <= 220 ? "7216321900" : "7216329900";
      },
      name: (s) => `${s.size} RSJ`,
    },

    // ---- hollow sections (21, 20, 26)
    {
      id: "shs", label: "Square hollow section (SHS)", group: "Hollow Sections",
      keywords: "shs box section square tube hollow",
      fields: [field("size", "Size × wall (mm)", SHS), gradeField(HOLLOW_GRADES), field("finish", "Finish", ["Black", "Pre-galvanised", "Hot-dip galvanised"]), lengthField(HOLLOW_LENGTHS)],
      code: (s) => (dims(s.size)[2] <= 2 ? "7306619200" : "7306619900"),
      name: (s) => `${s.size} SHS`,
    },
    {
      id: "rhs", label: "Rectangular hollow section (RHS)", group: "Hollow Sections",
      keywords: "rhs box section rectangular tube hollow",
      fields: [field("size", "Size × wall (mm)", RHS), gradeField(HOLLOW_GRADES), field("finish", "Finish", ["Black", "Pre-galvanised", "Hot-dip galvanised"]), lengthField(HOLLOW_LENGTHS)],
      code: (s) => (dims(s.size)[2] <= 2 ? "7306619200" : "7306619900"),
      name: (s) => `${s.size} RHS`,
    },
    {
      id: "chs", label: "Circular hollow section (CHS)", group: "Hollow Sections",
      keywords: "chs tube pipe round tube circular hollow",
      fields: [field("size", "Outside diameter × wall (mm)", CHS), gradeField(HOLLOW_GRADES), field("finish", "Finish", ["Black", "Galvanised"]), lengthField(HOLLOW_LENGTHS)],
      code: (s) => {
        const od = dims(s.size)[0];
        if (od > 168.3) return "7306308000";
        return s.finish === "Galvanised" ? "7306307280" : "7306307780";
      },
      name: (s) => `${s.size} CHS`,
    },

    // ---- plate, sheet and coil (1, 4, 5, 7)
    {
      id: "plate", label: "Plate", group: "Plate & Sheet",
      keywords: "plate hot rolled plate steel plate",
      fields: [field("size", "Thickness", PLATE_THICK.map(mm)), field("sheet", "Plate size (mm)", PLATE_SIZES), gradeField(PLATE_GRADES)],
      code: (s) => {
        const t = num(s.size);
        const width = dims(s.sheet)[1];
        if (t < 3) return "7208540000";
        if (t < 4.75) return "7208539000";
        if (t <= 10) return width >= 2050 ? "7208529110" : "7208529900";
        if (t <= 15) return width >= 2050 ? "7208519110" : "7208519810";
        return "7208512010";
      },
      name: (s) => `${s.size} Plate ${s.sheet}`,
    },
    {
      id: "wide-flat", label: "Wide flat (universal plate)", group: "Plate & Sheet",
      keywords: "wide flat universal plate",
      fields: [field("size", "Width × thickness (mm)", WIDE_FLATS), gradeField(PLATE_GRADES), lengthField(BAR_LENGTHS)],
      code: (s) => {
        const [w, t] = dims(s.size);
        return w <= 350 && t >= 50 ? "7211130011" : "7211130019";
      },
      name: (s) => `${s.size} Wide Flat`,
    },
    {
      id: "chequer-plate", label: "Chequer / tread plate", group: "Plate & Sheet",
      keywords: "chequer checker tread durbar floor plate",
      fields: [field("size", "Thickness", CHEQUER_THICK.map(mm)), field("sheet", "Plate size (mm)", ["2500×1250", "3000×1500", "4000×2000", "6000×2000"]), gradeField(["S275JR", "S235JR"])],
      code: (s) => (num(s.size) >= 2 ? "7208400010" : "7208400090"),
      name: (s) => `${s.size} Chequer Plate ${s.sheet}`,
    },
    {
      id: "hr-sheet", label: "Hot rolled sheet & coil", group: "Plate & Sheet",
      keywords: "hr sheet hot rolled coil hrpo pickled",
      fields: [field("size", "Thickness", SHEET_THICK_HR.map(mm)), field("sheet", "Sheet size", SHEET_SIZES), gradeField(SHEET_GRADES)],
      code: (s) => {
        const t = num(s.size);
        const coil = /coil/i.test(s.sheet || "");
        // black (unpickled) coil: 7208 37–39
        if (coil) return t < 3 ? "7208390090" : t < 4.75 ? "7208380090" : "7208370090";
        return t < 3 ? "7208540000" : "7208539000";
      },
      name: (s) => `${s.size} HR ${/coil/i.test(s.sheet || "") ? s.sheet : `Sheet ${s.sheet}`}`,
    },
    {
      id: "cr-sheet", label: "Cold rolled sheet", group: "Plate & Sheet",
      keywords: "cr sheet cold rolled cold reduced crca",
      fields: [field("size", "Thickness", SHEET_THICK_CR.map(mm)), field("sheet", "Sheet size", SHEET_SIZES.filter((v) => !/coil/i.test(v))), gradeField(["DC01", "DC03", "DC04"])],
      code: (s) => {
        const t = num(s.size);
        if (t >= 3) return "7209150090";
        if (t > 1) return "7209169000";
        if (t >= 0.5) return "7209179000";
        return "7209189990";
      },
      name: (s) => `${s.size} CR Sheet ${s.sheet}`,
    },
    {
      id: "galv-sheet", label: "Galvanised sheet & coil", group: "Plate & Sheet",
      keywords: "galv galvanised galvanized zinc sheet coil hdg",
      fields: [field("size", "Thickness", SHEET_THICK_GALV.map(mm)), field("sheet", "Sheet size", SHEET_SIZES), gradeField(GALV_GRADES)],
      code: () => ({ choose: "72104900" }),
      name: (s) => `${s.size} Galv ${/coil/i.test(s.sheet || "") ? s.sheet : `Sheet ${s.sheet}`}`,
    },
    {
      id: "painted-sheet", label: "Pre-painted (colour coated) sheet", group: "Plate & Sheet",
      keywords: "pre painted colour coated organic coated plastisol polyester sheet",
      fields: [field("size", "Thickness", [0.4, 0.5, 0.55, 0.6, 0.7, 0.8].map(mm)), field("sheet", "Sheet size", SHEET_SIZES), gradeField(["S280GD+Z", "DX51D+Z"])],
      code: () => ({ choose: "72107080" }),
      name: (s) => `${s.size} Pre-painted ${/coil/i.test(s.sheet || "") ? s.sheet : `Sheet ${s.sheet}`}`,
    },

    // ---- bright (cold finished) bar (27)
    {
      id: "bright-round", label: "Bright round bar", group: "Bright Bar",
      keywords: "bright round bar cold drawn cold finished bdmild",
      fields: [field("size", "Diameter", ROUNDS.filter((d) => d <= 150).map(mm)), gradeField(BRIGHT_GRADES), lengthField(BRIGHT_LENGTHS)],
      code: (s) => ({ free: "7215100000", low: "7215501900", high: "7215508000" })[carbonOf(BRIGHT_GRADES, s.grade)],
      name: (s) => `${s.size} Bright Round`,
    },
    {
      id: "bright-square", label: "Bright square bar", group: "Bright Bar",
      keywords: "bright square bar cold drawn",
      fields: [field("size", "Size", SQUARES.map(mm)), gradeField(BRIGHT_GRADES), lengthField(BRIGHT_LENGTHS)],
      code: (s) => ({ free: "7215100000", low: "7215501900", high: "7215508000" })[carbonOf(BRIGHT_GRADES, s.grade)],
      name: (s) => `${s.size} Bright Square`,
    },
    {
      id: "bright-hex", label: "Bright hexagon bar", group: "Bright Bar",
      keywords: "bright hex hexagon bar cold drawn",
      fields: [field("size", "Across flats", HEXES.map(mm)), gradeField(BRIGHT_GRADES), lengthField(BRIGHT_LENGTHS)],
      code: (s) => ({ free: "7215100000", low: "7215501900", high: "7215508000" })[carbonOf(BRIGHT_GRADES, s.grade)],
      name: (s) => `${s.size} Bright Hex`,
    },
    {
      id: "bright-flat", label: "Bright flat bar", group: "Bright Bar",
      keywords: "bright flat bar cold drawn",
      fields: [field("size", "Width × thickness (mm)", FLATS.filter((v) => dims(v)[0] <= 100)), gradeField(BRIGHT_GRADES), lengthField(BRIGHT_LENGTHS)],
      code: (s) => ({ free: "7215100000", low: "7215501100", high: "7215508000" })[carbonOf(BRIGHT_GRADES, s.grade)],
      name: (s) => `${s.size} Bright Flat`,
    },

    // ---- reinforcing (13, 16) and mesh
    {
      id: "rebar", label: "Rebar (reinforcing bar)", group: "Reinforcing",
      keywords: "rebar reinforcing bar b500b b500c deformed bar",
      fields: [field("size", "Diameter", REBAR.map(mm)), gradeField(["B500B", "B500C", "B500A"]), lengthField(["6 m", "12 m", "Cut & bent"])],
      code: () => ({ choose: "72142000" }),
      name: (s) => `${s.size} Rebar`,
    },
    {
      id: "rebar-coil", label: "Rebar in coil", group: "Reinforcing",
      keywords: "rebar coil reinforcing coil deformed coil",
      fields: [field("size", "Diameter", [6, 8, 10, 12, 16].map(mm)), gradeField(["B500B", "B500C", "B500A"])],
      code: () => "7213100000",
      name: (s) => `${s.size} Rebar Coil`,
    },
    {
      id: "mesh", label: "Reinforcing mesh", group: "Reinforcing",
      keywords: "mesh a142 a193 a252 a393 b503 fabric",
      fields: [field("size", "Mesh", ["A142", "A193", "A252", "A393", "B385", "B503", "B785", "C283", "C385", "C503", "C636", "D49", "D98"]), field("sheet", "Sheet size", ["4.8 × 2.4 m", "3.6 × 2.0 m"])],
      code: () => "7314201000",
      name: (s) => `${s.size} Mesh ${s.sheet}`,
    },

    // ---- wire rod and wire (16, 28)
    {
      id: "wire-rod", label: "Wire rod", group: "Wire & Rod",
      keywords: "wire rod coil sae1006 sae1008 sae1010",
      fields: [field("size", "Diameter", WIRE_ROD.map(mm)), gradeField(["SAE1006 (≤0.06% C)", "SAE1008", "SAE1010", "SAE1018", "Mesh quality", "SAE1070 (high carbon)", "SAE1080 (high carbon)"])],
      code: (s) => {
        const d = num(s.size);
        const g = s.grade || "";
        const high = /1070|1080/.test(g);
        if (d >= 14) return high ? "7213999000" : "7213991000";
        if (/Mesh/.test(g)) return "7213911000";
        if (/1006/.test(g)) return "7213914100";
        if (/1080/.test(g)) return "7213919000";
        if (/1070/.test(g)) return "7213917000";
        return "7213914900";
      },
      name: (s) => `${s.size} Wire Rod`,
    },
    {
      id: "wire", label: "Black / bright wire", group: "Wire & Rod",
      keywords: "wire black annealed bright drawn tying wire",
      fields: [field("size", "Diameter", WIRE.map(mm)), gradeField(["Low carbon (<0.25% C)", "Medium carbon (0.25–0.6% C)", "High carbon (≥0.6% C)"]), field("finish", "Finish", ["Black annealed", "Bright"])],
      code: (s) => {
        const d = num(s.size);
        if (/Medium/.test(s.grade || "")) return "7217105000";
        if (/High/.test(s.grade || "")) return d > 3 ? "7217109010" : "7217109090";
        return d < 0.8 ? "7217101000" : "7217103900";
      },
      name: (s) => `${s.size} ${s.finish === "Bright" ? "Bright" : "Black"} Wire`,
    },

    // ---- stainless (14)
    {
      id: "ss-round", label: "Stainless round bar (bright)", group: "Stainless",
      keywords: "stainless round bar 304 316 bright",
      fields: [field("size", "Diameter", ROUNDS.filter((d) => d <= 150).map(mm)), gradeField(STAINLESS_GRADES), lengthField(BRIGHT_LENGTHS)],
      code: (s) => {
        const d = num(s.size);
        const hi = nickelOf(s.grade) === "high";
        if (d >= 80) return hi ? "7222201100" : "7222201900";
        if (d >= 25) return hi ? "7222202100" : "7222202900";
        return hi ? "7222203100" : "7222203900";
      },
      name: (s) => `${s.size} Stainless Round`,
    },
    {
      id: "ss-round-hr", label: "Stainless round bar (hot rolled / peeled)", group: "Stainless",
      keywords: "stainless round bar hot rolled peeled black",
      fields: [field("size", "Diameter", ROUNDS.filter((d) => d >= 20).map(mm)), gradeField(STAINLESS_GRADES), lengthField(BAR_LENGTHS)],
      code: (s) => {
        const hi = nickelOf(s.grade) === "high";
        return num(s.size) >= 80 ? (hi ? "7222111100" : "7222111900") : (hi ? "7222118100" : "7222118900");
      },
      name: (s) => `${s.size} Stainless Round (HR)`,
    },
    {
      id: "ss-flat", label: "Stainless flat / square / hex (bright)", group: "Stainless",
      keywords: "stainless flat square hex bar 304 316 bright",
      fields: [field("size", "Size (mm)", [...FLATS.filter((v) => dims(v)[0] <= 100), ...SQUARES.map((v) => `${v} sq`), ...HEXES.map((v) => `${v} hex`)]), gradeField(STAINLESS_GRADES), lengthField(BRIGHT_LENGTHS)],
      code: (s) => (nickelOf(s.grade) === "high" ? "7222208100" : "7222208900"),
      name: (s) => `${s.size} Stainless Bar`,
    },
    {
      id: "ss-angle", label: "Stainless angle (cold formed)", group: "Stainless",
      keywords: "stainless angle 304 316",
      fields: [field("size", "Size (mm)", EQUAL_ANGLES.filter((v) => dims(v)[0] <= 100)), gradeField(STAINLESS_GRADES), lengthField(ANGLE_LENGTHS)],
      code: () => "7222405000",
      name: (s) => `${s.size} Stainless Angle`,
    },
  ];

  const groups = [...new Set(families.map((f) => f.group))];

  // ---------------------------------------------------------------- API
  const familyById = (id) => families.find((f) => f.id === id) || null;

  function defaults(family) {
    const sel = {};
    for (const f of family.fields) sel[f.key] = f.key === "size" ? "" : f.values[0];
    return sel;
  }

  // Everything the form needs from a family + selection.
  function resolve(familyId, sel = {}) {
    const family = familyById(familyId);
    if (!family || !sel.size) return null;
    const full = { ...defaults(family), ...sel };
    const code = family.code(full);
    const spec = family.fields.filter((f) => f.key !== "size" && !(family.name(full).includes(full[f.key]))).map((f) => full[f.key]).filter(Boolean).join(", ");
    return {
      family: family.id,
      values: full,
      name: family.name(full),
      category: family.group,
      spec,
      commodityCode: typeof code === "string" ? code : null,
      choosePrefix: typeof code === "object" ? code.choose : null,
    };
  }

  // Search index: one entry per family × size, plus one per family.
  const norm = (s) => String(s).toLowerCase().replace(/[×*]/g, "x").replace(/(\d)\s*x\s*(\d)/g, "$1x$2").replace(/(\d)\s*mm\b/g, "$1").replace(/[^a-z0-9.x/ ]+/g, " ").replace(/\s+/g, " ").trim();
  let index = null;
  function buildIndex() {
    index = [];
    for (const f of families) {
      const base = norm(`${f.label} ${f.short || ""} ${f.keywords || ""} ${f.group}`);
      index.push({ family: f.id, size: "", label: f.label, group: f.group, hay: base, rank: 0 });
      for (const v of f.fields[0].values) {
        index.push({ family: f.id, size: v, label: f.name({ ...defaults(f), size: v, sheet: "" }).replace(/\s+$/, ""), group: f.group, hay: `${norm(v)} ${base}`, rank: 1 });
      }
    }
  }

  // Every word typed must appear; sizes match from the start ("40x40" finds
  // 40×40×3, 40×40×4 …). Families come first, then sizes in catalogue order.
  function search(query, { limit = 60, groups: allowed = null } = {}) {
    if (!index) buildIndex();
    const words = norm(query).split(" ").filter(Boolean);
    const out = [];
    for (const item of index) {
      if (allowed && !allowed.includes(item.group)) continue;
      if (!words.length) { if (item.rank === 0) out.push(item); continue; }
      const tokens = item.hay.split(" ");
      const ok = words.every((w) => (/^\d/.test(w) ? tokens.some((t) => t === w || t.startsWith(`${w}x`) || (w.endsWith("x") && t.startsWith(w))) : tokens.some((t) => t.startsWith(w))));
      if (ok) out.push(item);
      if (out.length >= Math.max(limit * 10, 600)) break;
    }
    const sizeTyped = words.some((w) => /^\d/.test(w));
    out.sort((a, b) => (sizeTyped ? b.rank - a.rank : a.rank - b.rank));
    return out.slice(0, limit);
  }

  // Best catalogue match for an existing product (by name, then code).
  function match(name, commodityCode) {
    const hits = search(name, { limit: 20 }).filter((h) => h.size);
    if (!hits.length) return null;
    const exact = hits.find((h) => { const r = resolve(h.family, { size: h.size }); return r && r.commodityCode === commodityCode; });
    const h = exact || null;
    return h ? { family: h.family, values: { size: h.size } } : null;
  }

  const api = { families, groups, familyById, defaults, resolve, search, match, norm };
  root.STEEL_CATALOGUE = api;
})(typeof window !== "undefined" ? window : globalThis);
