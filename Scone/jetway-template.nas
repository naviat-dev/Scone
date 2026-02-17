# Absoulte center of the current jetway
# The property that the jetway is tied to will be a function of these coordinates
# These are the only things that should change throughout this script
var centerLongitude = 0;
var centerLatitude = 0;
var centerAltitude = 0;
var centerHeading = 0;
var centerMainHandle = 0;
var centerSecondaryHandle = 0;
var centerWheelsGroundLock = 0;
var jetwayLimits = [0, 0, 0]; # length, depth, height
var jetwayId = "";

# Initial position of the aircraft
var longitude = getprop("position/longitude-deg");
var latitude = getprop("position/latitude-deg");
var altitude = getprop("position/altitude-ft");

# List of doors defined on the aircraft
var doors = [];
while (true) {
	var currentIndex = size(doors);
	if (getprop("sim/model/door[" ~ currentIndex ~ "]/position-x-m") == nil
		or getprop("sim/model/door[" ~ currentIndex ~ "]/position-y-m") == nil
		or getprop("sim/model/door[" ~ currentIndex ~ "]/position-z-m") == nil) {
		break;
	}
	append(doors, [
		getprop("sim/model/door[" ~ currentIndex ~ "]/position-x-m"),
		getprop("sim/model/door[" ~ currentIndex ~ "]/position-y-m"),
		getprop("sim/model/door[" ~ currentIndex ~ "]/position-z-m")
	]);
}

# Change the position of the aircraft doors to absolute coordinates
for (var i = 0; i < size(doors); i+=1) {
	var door = doors[i];
	var doorLongitude = longitude + (door[0] / (111320 * math.cos(latitude * 3.141592653589793 / 180)));
	var doorLatitude = latitude + (door[1] / 110540);
	var doorAltitude = altitude + door[2];
	doors[i] = [doorLongitude, doorLatitude, doorAltitude];
}