import { setupServer } from "msw/node"

import { defaultHandlers } from "./contract-handlers"

export const server = setupServer(...defaultHandlers)
