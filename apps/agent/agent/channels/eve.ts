import { disableRoute } from "eve/channels";

// The built-in API of eve, which lets a client open and read sessions, is removed: the server
// reaches the agent only through the kira channel.
export default disableRoute();
