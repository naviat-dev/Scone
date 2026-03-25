# Absoulte center of the current jetway
# The property that the jetway is tied to will be a function of these coordinates
# These are the only things that should change throughout this script
# NOTE: jetways face 270 degrees by default, so ensure to add 270 degrees to the heading before calculations
var jetwayLongitude = 0;
var jetwayLatitude = 0;
var jetwayAltitude = 0;
var jetwayHeading = 0;
var distMainHandleInit = 0;
var distMainHandleFinal = 0;
var distSecondaryHandle = 0;
var centerWheelsGroundLock = 0;
var jetwayLimits = [0, 0]; # length and height
var jetwayId = "";
var jetwayPropNode = "scone/jetway-" ~ jetwayId;

# Initial position of the aircraft
var longitude = getprop("position/longitude-deg");
var latitude = getprop("position/latitude-deg");
var altitude = getprop("position/altitude-ft");
var heading = getprop("orientation/heading-deg");

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
if (size(doors) == 0) {
	gui.popupTip("Cannot extend jetway: Your aircraft does not define the required positioning information.");
}
# Change the position of the aircraft doors to absolute coordinates
for (var i = 0; i < size(doors); i+=1) {
	var door = doors[i];
	var doorLongitude = longitude + (door[0] / (111320 * math.cos(latitude * 3.141592653589793 / 180)));
	var doorLatitude = latitude + (door[1] / 110540);
	var doorAltitude = altitude + door[2];
	doors[i] = [doorLongitude, doorLatitude, doorAltitude];
}

# Find the closest door to the jetway's end and see if it is within the constraints
var closestDoorIndex = -1;
var closestDoorDistance = 1000000;
var closestDoorPivotPoint = [0, 0, 0];
for (var i = 0; i < size(doors); i+=1) {
	var door = doors[i];
	# Actually calculate the distance the jetway would have to extend to reach the door
	var R = 6371000; # Earth radius in meters

	# convert to radians
	var phi1 = latitude * math.pi / 180;
	var lambda1 = longitude * math.pi / 180;
	var theta  = heading * math.pi / 180;

	var delta = distSecondaryHandle / R; # angular distance

	var sinPhi1 = math.sin(phi1);
	var cosPhi1 = math.cos(phi1);
	var sinDelta = math.sin(delta);
	var cosDelta = math.cos(delta);

	var phi2 = math.asin(
		sinPhi1 * cosDelta +
		cosPhi1 * sinDelta * math.cos(theta)
	);

	var lambda2 = lambda1 + math.atan2(
		math.sin(theta) * sinDelta * cosPhi1,
		cosDelta - sinPhi1 * math.sin(phi2)
	);

	# convert back to degrees
	var lat2 = phi2 * 180 / math.pi;
	var lon2 = (math.mod((lambda2 * 180 / math.pi) + 540, 360)) - 180;

	var distance = math.sqrt(math.pow(door[0] - jetwayLongitude, 2) + math.pow(door[1] - jetwayLatitude, 2) + math.pow(door[2] - jetwayAltitude, 2));
	if (distance < closestDoorDistance) {
		closestDoorDistance = distance;
		closestDoorIndex = i;
		closestDoorPivotPoint = [lon2, lat2, jetwayAltitude];
	}
}

if (closestDoorIndex == -1) {
	gui.popupTip("Cannot extend jetway: No aircraft door was found.");
} else {
	var closestDoor = doors[closestDoorIndex];
	# Calculate the required extension of the jetway to reach the door
	var R = 6371000; # Earth radius in meters
	var phi1 = jetwayLatitude * math.pi / 180;
	var phi2 = closestDoorPivotPoint[1] * math.pi / 180;
	var deltaPhi = (closestDoorPivotPoint[1] - jetwayLatitude) * math.pi / 180;
	var deltaLambda = (closestDoorPivotPoint[0] - jetwayLongitude) * math.pi / 180;

	var a = math.sin(deltaPhi / 2) * math.sin(deltaPhi / 2) +
	math.cos(phi1) * math.cos(phi2) *
	math.sin(deltaLambda / 2) * math.sin(deltaLambda / 2);
	var c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a));
	var horizontalDistance = R * c;

	var requiredExtension = math.sqrt(math.pow(horizontalDistance, 2) + math.pow(closestDoorPivotPoint[2] - jetwayAltitude, 2));
	var requiredHeading = math.mod(math.atan2(closestDoorPivotPoint[0] - jetwayLongitude, closestDoorPivotPoint[1] - jetwayLatitude) * 180 / math.pi + 360, 360);
	if (requiredExtension > distMainHandleFinal) {
		gui.popupTip("Cannot extend jetway: The closest door is " ~ math.round(requiredExtension, 2) ~ " meters away, which exceeds the maximum extension limit of " ~ distMainHandleFinal ~ " meters.");
	} else if (requiredExtension < distMainHandleInit) {
		gui.popupTip("Cannot extend jetway: The closest door is " ~ math.round(requiredExtension, 2) ~ " meters away, which is less than the minimum extension limit of " ~ distMainHandleInit ~ " meters.");
	} else {
		# Extend the jetway to the required extension
		setprop(jetwayPropNode ~ "/extension-m", requiredExtension);
		setprop(jetwayPropNode ~ "/secondary-handle-rotation-deg", heading - jetwayHeading);
		setprop(jetwayPropNode ~ "/main-handle-rotation-deg", requiredHeading - jetwayHeading);
	}
}
