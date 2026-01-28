using System.Numerics;

namespace Scone;

public class AcObject
{
	public ulong Kids { get; private set; } = 0;
	public string Name { get; private set; } = "";
	public List<AcWorld> Worlds { get; private set; } = [];

	public AcObject() { }
	public AcObject(string name)
	{
		Name = name;
	}
}

public class AcWorld : AcObject
{
	public AcWorld() { }
}

public class AcPoly : AcObject
{
	
}

public class AcGroup : AcObject
{
	
}

public struct AcMaterial
{
	public string? Name;
	public Vector3 Rgb;
	public Vector3 Ambient;
	public Vector3 Emissive;
	public Vector3 Specular;
	public float Shininess;
	public float Transparency;
}