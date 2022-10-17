import { useLocation, useParams } from "@remix-run/react";
import type {
  MenuItem,
  Menu,
  MoneyV2,
  UserError,
  CountryCode,
  LanguageCode,
} from "@shopify/hydrogen-ui-alpha/storefront-api-types";

// @ts-expect-error types not available
import typographicBase from "typographic-base";

export interface EnhancedMenuItem extends MenuItem {
  to: string;
  target: string;
  isExternal?: boolean;
  items: EnhancedMenuItem[];
}

export interface EnhancedMenu extends Menu {
  items: EnhancedMenuItem[];
}

export function missingClass(string?: string, prefix?: string) {
  if (!string) {
    return true;
  }

  const regex = new RegExp(` ?${prefix}`, "g");
  return string.match(regex) === null;
}

export function formatText(input?: string | React.ReactNode) {
  if (!input) {
    return;
  }

  if (typeof input !== "string") {
    return input;
  }

  return typographicBase(input, { locale: "en-us" }).replace(
    /\s([^\s<]+)\s*$/g,
    "\u00A0$1"
  );
}

export function getExcerpt(text: string) {
  const regex = /<p.*>(.*?)<\/p>/;
  const match = regex.exec(text);
  return match?.length ? match[0] : text;
}

export function isNewArrival(date: string, daysOld = 30) {
  return (
    new Date(date).valueOf() >
    new Date().setDate(new Date().getDate() - daysOld).valueOf()
  );
}

export function isDiscounted(price: MoneyV2, compareAtPrice: MoneyV2) {
  if (compareAtPrice?.amount > price?.amount) {
    return true;
  }
  return false;
}

function resolveToFromType(
  {
    customPrefixes,
    pathname,
    type,
  }: {
    customPrefixes: Record<string, string>;
    pathname?: string;
    type?: string;
  } = {
    customPrefixes: {},
  }
) {
  if (!pathname || !type) return "";

  /*
    MenuItemType enum
    @see: https://shopify.dev/api/storefront/unstable/enums/MenuItemType
  */
  const defaultPrefixes = {
    BLOG: "blogs",
    COLLECTION: "collections",
    COLLECTIONS: "collections", // Collections All (not documented)
    FRONTPAGE: "frontpage",
    HTTP: "",
    PAGE: "pages",
    CATALOG: "collections/all", // Products All
    PRODUCT: "products",
    SEARCH: "search",
    SHOP_POLICY: "policies",
  };

  const pathParts = pathname.split("/");
  const handle = pathParts.pop() || "";
  const routePrefix: Record<string, string> = {
    ...defaultPrefixes,
    ...customPrefixes,
  };

  switch (true) {
    // special cases
    case type === "FRONTPAGE":
      return "/";

    case type === "ARTICLE": {
      const blogHandle = pathParts.pop();
      return routePrefix.BLOG
        ? `/${routePrefix.BLOG}/${blogHandle}/${handle}/`
        : `/${blogHandle}/${handle}/`;
    }

    case type === "COLLECTIONS":
      return `/${routePrefix.COLLECTIONS}`;

    case type === "SEARCH":
      return `/${routePrefix.SEARCH}`;

    case type === "CATALOG":
      return `/${routePrefix.CATALOG}`;

    // common cases: BLOG, PAGE, COLLECTION, PRODUCT, SHOP_POLICY, HTTP
    default:
      return routePrefix[type]
        ? `/${routePrefix[type]}/${handle}`
        : `/${handle}`;
  }
}

/*
  Parse each menu link and adding, isExternal, to and target
*/
function parseItem(customPrefixes = {}) {
  return function (item: MenuItem): EnhancedMenuItem {
    if (!item?.url || !item?.type) {
      // eslint-disable-next-line no-console
      console.warn("Invalid menu item.  Must include a url and type.");
      // @ts-ignore
      return;
    }

    // extract path from url because we don't need the origin on internal to attributes
    const { pathname } = new URL(item.url);

    /*
      Currently the MenuAPI only returns online store urls e.g — xyz.myshopify.com/..
      Note: update logic when API is updated to include the active qualified domain
    */
    const isInternalLink = /\.myshopify\.com/g.test(item.url);

    const parsedItem = isInternalLink
      ? // internal links
        {
          ...item,
          isExternal: false,
          target: "_self",
          to: resolveToFromType({ type: item.type, customPrefixes, pathname }),
        }
      : // external links
        {
          ...item,
          isExternal: true,
          target: "_blank",
          to: item.url,
        };

    return {
      ...parsedItem,
      items: item.items?.map(parseItem(customPrefixes)),
    };
  };
}

/*
  Recursively adds `to` and `target` attributes to links based on their url
  and resource type.
  It optionally overwrites url paths based on item.type
*/
export function parseMenu(menu: Menu, customPrefixes = {}): EnhancedMenu {
  if (!menu?.items) {
    // eslint-disable-next-line no-console
    console.warn("Invalid menu passed to parseMenu");
    // @ts-ignore
    return menu;
  }

  return {
    ...menu,
    items: menu.items.map(parseItem(customPrefixes)),
  };
}

export const INPUT_STYLE_CLASSES =
  "appearance-none rounded dark:bg-transparent border focus:border-primary/50 focus:ring-0 w-full py-2 px-3 text-primary/90 placeholder:text-primary/50 leading-tight focus:shadow-outline";

export const getInputStyleClasses = (isError?: string | null) => {
  return `${INPUT_STYLE_CLASSES} ${
    isError ? "border-red-500" : "border-primary/20"
  }`;
};

export function statusMessage(status: string) {
  const translations: Record<string, string> = {
    ATTEMPTED_DELIVERY: "Attempted delivery",
    CANCELED: "Canceled",
    CONFIRMED: "Confirmed",
    DELIVERED: "Delivered",
    FAILURE: "Failure",
    FULFILLED: "Fulfilled",
    IN_PROGRESS: "In Progress",
    IN_TRANSIT: "In transit",
    LABEL_PRINTED: "Label printed",
    LABEL_PURCHASED: "Label purchased",
    LABEL_VOIDED: "Label voided",
    MARKED_AS_FULFILLED: "Marked as fulfilled",
    NOT_DELIVERED: "Not delivered",
    ON_HOLD: "On Hold",
    OPEN: "Open",
    OUT_FOR_DELIVERY: "Out for delivery",
    PARTIALLY_FULFILLED: "Partially Fulfilled",
    PENDING_FULFILLMENT: "Pending",
    PICKED_UP: "Displayed as Picked up",
    READY_FOR_PICKUP: "Ready for pickup",
    RESTOCKED: "Restocked",
    SCHEDULED: "Scheduled",
    SUBMITTED: "Submitted",
    UNFULFILLED: "Unfulfilled",
  };
  try {
    return translations?.[status];
  } catch (error) {
    return status;
  }
}

/**
 * Errors can exist in an errors object, or nested in a data field.
 */
export function getApiErrorMessage(
  field: string,
  data: Record<string, any> | null | undefined,
  errors?: UserError[]
) {
  if (errors?.length) return errors[0].message ?? errors[0];
  if (data?.[field]?.customerUserErrors?.length)
    return data[field].customerUserErrors[0].message;
  return null;
}

export function getLocalizationFromLang(lang?: String): {
  language: LanguageCode;
  country: CountryCode;
} {
  if (lang && lang.includes("-")) {
    const [language, country] = lang.split("-");

    return {
      language: language?.toUpperCase() as LanguageCode,
      country: (country?.toUpperCase() || "US") as CountryCode,
    };
  }
  return {
    language: "EN" as LanguageCode,
    country: "US" as CountryCode,
  };
}

export function useIsHomePath() {
  const { pathname } = useLocation();
  const { lang } = useParams();
  const strippedPathname = pathname.replace(new RegExp(`^\/${lang}\/`), "/");

  return strippedPathname === "/";
}