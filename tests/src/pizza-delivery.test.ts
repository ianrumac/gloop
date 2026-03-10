import { test, expect, describe } from "bun:test";
import {
  calculateDistance,
  calculateDeliveryTime,
  calculateBaseCost,
  calculateFuelCost,
  calculateMaintenanceCost,
  calculateTip,
  calculateProfit,
  processOrder,
  generateRouteReport,
  type Planet,
  type Order,
} from "./pizza-delivery";

// --- Test Fixtures ---

const PLANETS: Planet[] = [
  { name: "Earth", x: 0, y: 0, demandMultiplier: 1.0 },
  { name: "Mars", x: 30, y: 40, demandMultiplier: 1.5 },
  { name: "Jupiter", x: 100, y: 0, demandMultiplier: 2.0 },
  { name: "Neptune", x: 0, y: 200, demandMultiplier: 3.0 },
  { name: "Alpha Centauri", x: 300, y: 400, demandMultiplier: 5.0 },
];

// --- Unit Tests ---

describe("calculateDistance", () => {
  test("same planet returns 0", () => {
    const earth = PLANETS[0]!;
    expect(calculateDistance(earth, earth)).toBe(0);
  });

  test("Earth to Mars (3-4-5 triangle)", () => {
    expect(calculateDistance(PLANETS[0]!, PLANETS[1]!)).toBe(50);
  });

  test("Earth to Jupiter (horizontal)", () => {
    expect(calculateDistance(PLANETS[0]!, PLANETS[2]!)).toBe(100);
  });

  test("distance is symmetric", () => {
    const d1 = calculateDistance(PLANETS[0]!, PLANETS[1]!);
    const d2 = calculateDistance(PLANETS[1]!, PLANETS[0]!);
    expect(d1).toBe(d2);
  });
});

describe("calculateDeliveryTime", () => {
  test("standard speed", () => {
    expect(calculateDeliveryTime(100, "standard")).toBe(100);
  });

  test("express is 1.5x faster", () => {
    expect(calculateDeliveryTime(150, "express")).toBe(100);
  });

  test("hyperspace is 3x faster", () => {
    expect(calculateDeliveryTime(300, "hyperspace")).toBe(100);
  });
});

describe("calculateBaseCost", () => {
  test("basic order", () => {
    // 15 * 2 * 1.0 + 10 * 0.5 + 0 = 30 + 5 = 35
    expect(calculateBaseCost(2, 10, 1.0, "standard")).toBe(35);
  });

  test("express surcharge", () => {
    // 15 * 2 * 1.0 + 10 * 0.5 + 20 = 30 + 5 + 20 = 55
    expect(calculateBaseCost(2, 10, 1.0, "express")).toBe(55);
  });

  test("high demand multiplier", () => {
    // 15 * 3 * 2.0 + 50 * 0.5 + 0 = 90 + 25 = 115
    expect(calculateBaseCost(3, 50, 2.0, "standard")).toBe(115);
  });
});

describe("calculateFuelCost", () => {
  test("base weight with no pizzas", () => {
    // distance=100, weight=1+0*0.1=1, cost=100*2.5*1=250
    expect(calculateFuelCost(100, 0)).toBe(250);
  });

  test("with pizzas", () => {
    // distance=50, weight=1+10*0.1=2, cost=50*2.5*2=250
    expect(calculateFuelCost(50, 10)).toBe(250);
  });
});

describe("calculateMaintenanceCost", () => {
  test("10% of base cost", () => {
    expect(calculateMaintenanceCost(100)).toBe(10);
    expect(calculateMaintenanceCost(250)).toBe(25);
  });
});

describe("calculateTip", () => {
  test("fast delivery (under half max time) gets 25%", () => {
    // deliveryTime=20, halfTime=50, baseCost=100, standard
    expect(calculateTip(100, 20, "standard")).toBe(25);
  });

  test("medium delivery (under 75% max time) gets 15%", () => {
    // deliveryTime=60, threeQuarterTime=75, baseCost=100, standard
    expect(calculateTip(100, 60, "standard")).toBe(15);
  });

  test("slow delivery gets 5%", () => {
    // deliveryTime=80, baseCost=100, standard
    expect(calculateTip(100, 80, "standard")).toBe(5);
  });

  test("delivery at exactly half max time should get 25% tip", () => {
    // deliveryTime=50 (exactly half of 100), baseCost=200, standard
    // Half time = 50, so deliveryTime <= halfTime should give 25%
    expect(calculateTip(200, 50, "standard")).toBe(50); // 200 * 0.25 = 50
  });

  test("express priority gets 1.2x tip bonus", () => {
    // deliveryTime=20, baseCost=100, express
    expect(calculateTip(100, 20, "express")).toBe(30); // 100 * 0.25 * 1.2
  });

  test("hyperspace priority gets 1.5x tip bonus", () => {
    // deliveryTime=20, baseCost=100, hyperspace
    expect(calculateTip(100, 20, "hyperspace")).toBe(37.5); // 100 * 0.25 * 1.5
  });
});

describe("calculateProfit", () => {
  test("basic profit calculation", () => {
    // revenue = baseCost + tip = 100 + 25 = 125
    // profit = 125 - fuelCost - maintenanceCost = 125 - 50 - 10 = 65
    expect(calculateProfit(100, 25, 50, 10)).toBe(65);
  });

  test("negative profit when costs exceed revenue", () => {
    // revenue = 50 + 5 = 55
    // profit = 55 - 100 - 20 = -65
    expect(calculateProfit(50, 5, 100, 20)).toBe(-65);
  });

  test("zero fuel cost", () => {
    // revenue = 100 + 10 = 110
    // profit = 110 - 0 - 5 = 105
    expect(calculateProfit(100, 10, 0, 5)).toBe(105);
  });

  test("maintenance cost matters", () => {
    // With maintenance=0: profit = (100+20) - 30 - 0 = 90
    // With maintenance=15: profit = (100+20) - 30 - 15 = 75
    const withoutMaintenance = calculateProfit(100, 20, 30, 0);
    const withMaintenance = calculateProfit(100, 20, 30, 15);
    expect(withoutMaintenance).toBe(90);
    expect(withMaintenance).toBe(75);
  });
});

describe("processOrder", () => {
  test("Earth to Mars standard delivery", () => {
    const order: Order = {
      id: "order-1",
      from: "Earth",
      to: "Mars",
      pizzas: 5,
      priority: "standard",
    };

    const result = processOrder(PLANETS, order);

    expect(result.orderId).toBe("order-1");
    expect(result.distance).toBe(50); // 3-4-5 triangle
    expect(result.deliveryTime).toBe(50); // 50 / 1.0
    expect(result.baseCost).toBe(137.5); // 15*5*1.5 + 50*0.5 + 0
    expect(result.fuelCost).toBe(187.5); // 50 * 2.5 * (1+5*0.1)
    expect(result.maintenanceCost).toBe(13.75); // 137.5 * 0.1
  });

  test("throws for unknown planet", () => {
    const order: Order = {
      id: "bad",
      from: "Earth",
      to: "Pluto",
      pizzas: 1,
      priority: "standard",
    };
    expect(() => processOrder(PLANETS, order)).toThrow("Unknown planet: Pluto");
  });
});

describe("generateRouteReport", () => {
  test("filters out orders that exceed max delivery time", () => {
    const orders: Order[] = [
      {
        id: "fast",
        from: "Earth",
        to: "Mars",
        pizzas: 2,
        priority: "standard",
      },
      {
        id: "slow",
        from: "Earth",
        to: "Neptune",
        pizzas: 2,
        priority: "standard",
      }, // distance=200, time=200 > 100
    ];

    const report = generateRouteReport(PLANETS, orders);
    expect(report.totalDeliveries).toBe(1);
    expect(report.deliveries[0]!.orderId).toBe("fast");
  });

  test("sorts deliveries by profit descending", () => {
    const orders: Order[] = [
      {
        id: "small",
        from: "Earth",
        to: "Mars",
        pizzas: 1,
        priority: "standard",
      },
      {
        id: "big",
        from: "Earth",
        to: "Mars",
        pizzas: 10,
        priority: "standard",
      },
    ];

    const report = generateRouteReport(PLANETS, orders);
    expect(report.deliveries.length).toBe(2);
    // The bigger order should have higher profit and be first
    expect(report.deliveries[0]!.orderId).toBe("big");
  });

  test("empty orders produce empty report", () => {
    const report = generateRouteReport(PLANETS, []);
    expect(report.totalDeliveries).toBe(0);
    expect(report.totalProfit).toBe(0);
    expect(report.averageTime).toBe(0);
    expect(report.bestDelivery).toBeNull();
  });

  test("bestDelivery is the most profitable", () => {
    const orders: Order[] = [
      {
        id: "a",
        from: "Earth",
        to: "Mars",
        pizzas: 3,
        priority: "express",
      },
      {
        id: "b",
        from: "Earth",
        to: "Mars",
        pizzas: 8,
        priority: "standard",
      },
    ];

    const report = generateRouteReport(PLANETS, orders);
    expect(report.bestDelivery).not.toBeNull();
    // bestDelivery should be the one with highest profit
    const profits = report.deliveries.map((d) => d.profit);
    expect(report.bestDelivery!.profit).toBe(Math.max(...profits));
  });

  test("totalProfit sums all delivery profits", () => {
    const orders: Order[] = [
      {
        id: "x",
        from: "Earth",
        to: "Mars",
        pizzas: 2,
        priority: "standard",
      },
      {
        id: "y",
        from: "Earth",
        to: "Jupiter",
        pizzas: 3,
        priority: "express",
      },
    ];

    const report = generateRouteReport(PLANETS, orders);
    const manualSum = report.deliveries.reduce((s, d) => s + d.profit, 0);
    expect(report.totalProfit).toBeCloseTo(manualSum);
  });
});
