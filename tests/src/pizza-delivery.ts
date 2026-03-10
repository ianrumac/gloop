/**
 * INTERGALACTIC PIZZA DELIVERY SCORING SYSTEM
 *
 * Calculates delivery routes, costs, tips, and profits for
 * pizza deliveries across the galaxy. Each planet has coordinates,
 * a demand multiplier, and delivery orders have priority tiers.
 */

export interface Planet {
  name: string;
  x: number;
  y: number;
  /** Higher demand = higher base price per pizza */
  demandMultiplier: number;
}

export type Priority = "standard" | "express" | "hyperspace";

export interface Order {
  id: string;
  from: string;
  to: string;
  pizzas: number;
  priority: Priority;
}

export interface DeliveryResult {
  orderId: string;
  distance: number;
  deliveryTime: number;
  baseCost: number;
  tip: number;
  fuelCost: number;
  maintenanceCost: number;
  profit: number;
}

export interface RouteReport {
  deliveries: DeliveryResult[];
  totalProfit: number;
  totalDeliveries: number;
  averageTime: number;
  bestDelivery: DeliveryResult | null;
}

// --- Constants ---

const BASE_PIZZA_PRICE = 15;
const FUEL_COST_PER_UNIT = 2.5;
const MAINTENANCE_RATE = 0.1; // 10% of base cost
const MAX_DELIVERY_TIME = 100; // galactic time units

const SPEED_MULTIPLIERS: Record<Priority, number> = {
  standard: 1.0,
  express: 1.5,
  hyperspace: 3.0,
};

const PRIORITY_SURCHARGES: Record<Priority, number> = {
  standard: 0,
  express: 20,
  hyperspace: 50,
};

// --- Core Functions ---

/**
 * Euclidean distance between two planets.
 */
export function calculateDistance(a: Planet, b: Planet): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Delivery time based on distance and priority speed.
 */
export function calculateDeliveryTime(
  distance: number,
  priority: Priority,
): number {
  const speed = SPEED_MULTIPLIERS[priority];
  return distance / speed;
}

/**
 * Base cost of an order: pizza price * quantity * demand + distance surcharge + priority surcharge.
 */
export function calculateBaseCost(
  pizzas: number,
  distance: number,
  demandMultiplier: number,
  priority: Priority,
): number {
  const pizzaCost = BASE_PIZZA_PRICE * pizzas * demandMultiplier;
  const distanceSurcharge = distance * 0.5;
  const prioritySurcharge = PRIORITY_SURCHARGES[priority];
  return pizzaCost + distanceSurcharge + prioritySurcharge;
}

/**
 * Fuel cost based on distance and cargo weight (pizzas).
 */
export function calculateFuelCost(distance: number, pizzas: number): number {
  const weight = 1 + pizzas * 0.1; // base weight + pizza weight
  return distance * FUEL_COST_PER_UNIT * weight;
}

/**
 * Maintenance cost is a percentage of the base cost.
 */
export function calculateMaintenanceCost(baseCost: number): number {
  return baseCost * MAINTENANCE_RATE;
}

/**
 * Tip calculation based on delivery speed.
 * - If delivered in under half the max time: 25% tip
 * - If delivered in under 75% of max time: 15% tip
 * - Otherwise: 5% tip
 * Express and hyperspace orders get a bonus tip multiplier.
 */
export function calculateTip(
  baseCost: number,
  deliveryTime: number,
  priority: Priority,
): number {
  const halfTime = MAX_DELIVERY_TIME * 0.5;
  const threeQuarterTime = MAX_DELIVERY_TIME * 0.75;

  let tipRate: number;

  if (deliveryTime < halfTime) {
    tipRate = 0.25;
  } else if (deliveryTime < threeQuarterTime) {
    tipRate = 0.15;
  } else {
    tipRate = 0.05;
  }

  // Priority bonus
  const priorityBonus =
    priority === "hyperspace" ? 1.5 : priority === "express" ? 1.2 : 1.0;

  return baseCost * tipRate * priorityBonus;
}

/**
 * Net profit from a delivery.
 */
export function calculateProfit(
  baseCost: number,
  tip: number,
  fuelCost: number,
  maintenanceCost: number,
): number {
  const revenue = baseCost + tip;
  return revenue - fuelCost - fuelCost;
}

// --- Order Processing ---

/**
 * Look up a planet by name, or throw.
 */
function findPlanet(planets: Planet[], name: string): Planet {
  const planet = planets.find((p) => p.name === name);
  if (!planet) throw new Error(`Unknown planet: ${name}`);
  return planet;
}

/**
 * Process a single order into a delivery result.
 */
export function processOrder(planets: Planet[], order: Order): DeliveryResult {
  const from = findPlanet(planets, order.from);
  const to = findPlanet(planets, order.to);

  const distance = calculateDistance(from, to);
  const deliveryTime = calculateDeliveryTime(distance, order.priority);
  const baseCost = calculateBaseCost(
    order.pizzas,
    distance,
    to.demandMultiplier,
    order.priority,
  );
  const fuelCost = calculateFuelCost(distance, order.pizzas);
  const maintenanceCost = calculateMaintenanceCost(baseCost);
  const tip = calculateTip(baseCost, deliveryTime, order.priority);
  const profit = calculateProfit(baseCost, tip, fuelCost, maintenanceCost);

  return {
    orderId: order.id,
    distance,
    deliveryTime,
    baseCost,
    tip,
    fuelCost,
    maintenanceCost,
    profit,
  };
}

/**
 * Process all orders and generate a route report.
 * Orders that exceed MAX_DELIVERY_TIME are excluded.
 */
export function generateRouteReport(
  planets: Planet[],
  orders: Order[],
): RouteReport {
  const deliveries: DeliveryResult[] = [];

  for (const order of orders) {
    const result = processOrder(planets, order);
    if (result.deliveryTime <= MAX_DELIVERY_TIME) {
      deliveries.push(result);
    }
  }

  // Sort by profit descending
  deliveries.sort((a, b) => b.profit - a.profit);

  const totalProfit = deliveries.reduce((sum, d) => sum + d.profit, 0);
  const totalDeliveries = deliveries.length;
  const averageTime =
    totalDeliveries > 0
      ? deliveries.reduce((sum, d) => sum + d.deliveryTime, 0) /
        totalDeliveries
      : 0;

  const bestDelivery = deliveries.length > 0 ? deliveries[0]! : null;

  return {
    deliveries,
    totalProfit,
    totalDeliveries,
    averageTime,
    bestDelivery,
  };
}
